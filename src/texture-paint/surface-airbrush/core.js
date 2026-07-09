import * as THREE from "../../../node_modules/three/build/three.webgpu.js";

const _world = new THREE.Vector3();

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function finiteComponentId(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : -1;
}

export function clamp01(value) {
  return Math.max(0, Math.min(1, finiteNumber(value, 0)));
}

export function finitePoint(point = null) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
}

export function pointDistance(left = null, right = null) {
  return Number.isFinite(left?.x) && Number.isFinite(left?.y) && Number.isFinite(right?.x) && Number.isFinite(right?.y)
    ? Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y))
    : Infinity;
}

export function finiteView(point = null) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z)
    ? { x: Number(point.x), y: Number(point.y), z: Number(point.z) }
    : null;
}

export function worldFromView(editor = null, point = null) {
  if (!editor?.camera || !finiteView(point)) {
    return null;
  }
  const world = _world.set(point.x, point.y, point.z).applyMatrix4(editor.camera.matrixWorld);
  return Number.isFinite(world.x) && Number.isFinite(world.y) && Number.isFinite(world.z)
    ? { x: world.x, y: world.y, z: world.z }
    : null;
}

export function viewFromScreenPoint(point = null) {
  return Number.isFinite(point?.viewX) && Number.isFinite(point?.viewY) && Number.isFinite(point?.viewZ)
    ? { x: Number(point.viewX), y: Number(point.viewY), z: Number(point.viewZ) }
    : finiteView(point);
}

export function triangleArea2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function barycentricForPoint(point, a, b, c) {
  const denom = triangleArea2(a, b, c);
  if (!Number.isFinite(denom) || Math.abs(denom) <= 0.000001) {
    return null;
  }
  const u = triangleArea2(point, b, c) / denom;
  const v = triangleArea2(a, point, c) / denom;
  const w = triangleArea2(a, b, point) / denom;
  return { u, v, w };
}

export function interpolateView(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  return {
    x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
    y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w,
    z: a.z * barycentric.u + b.z * barycentric.v + c.z * barycentric.w
  };
}

export function interpolateScreen(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  return {
    x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
    y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w,
    z: finiteNumber(a.z, 0) * barycentric.u
      + finiteNumber(b.z, 0) * barycentric.v
      + finiteNumber(c.z, 0) * barycentric.w
  };
}

export function clampBarycentricToTriangle(barycentric = null) {
  if (!barycentric) {
    return null;
  }
  const u = Math.max(0, finiteNumber(barycentric.u, 0));
  const v = Math.max(0, finiteNumber(barycentric.v, 0));
  const w = Math.max(0, finiteNumber(barycentric.w, 0));
  const sum = u + v + w;
  if (sum <= 0.000001) {
    return { u: 1, v: 0, w: 0 };
  }
  return {
    u: u / sum,
    v: v / sum,
    w: w / sum
  };
}

export function interpolatePoint2(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  return {
    x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
    y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w
  };
}

export function interpolateNormal(barycentric, a, b, c) {
  if (!barycentric || !a || !b || !c) {
    return null;
  }
  const x = a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w;
  const y = a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w;
  const z = a.z * barycentric.u + b.z * barycentric.v + c.z * barycentric.w;
  const length = Math.hypot(x, y, z);
  if (length <= 0.000001) {
    return null;
  }
  return { x: x / length, y: y / length, z: z / length };
}

function rightNormal(edge) {
  const length = Math.hypot(edge.x, edge.y);
  if (length <= 0.000001) {
    return { x: 0, y: 0 };
  }
  return { x: edge.y / length, y: -edge.x / length };
}

function outwardNormal(edge, ccw) {
  const normal = rightNormal(edge);
  return ccw ? normal : { x: -normal.x, y: -normal.y };
}

function expandCorner(point, center, firstNormal, secondNormal, margin) {
  let x = firstNormal.x + secondNormal.x;
  let y = firstNormal.y + secondNormal.y;
  if (x * x + y * y <= 0.000001) {
    x = point.x - center.x;
    y = point.y - center.y;
  }
  const length = Math.hypot(x, y);
  if (length <= 0.000001) {
    return point;
  }
  x /= length;
  y /= length;
  const firstDot = Math.abs(x * firstNormal.x + y * firstNormal.y);
  const secondDot = Math.abs(x * secondNormal.x + y * secondNormal.y);
  const miterDenom = Math.max(0.35, firstDot, secondDot);
  const miterLength = Math.min(margin * 4, margin / miterDenom);
  return {
    x: point.x + x * miterLength,
    y: point.y + y * miterLength
  };
}

export function expandedTrianglePoints(a, b, c, margin = 0) {
  const center = {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3
  };
  const ccw = triangleArea2(a, b, c) > 0;
  const normalAB = outwardNormal({ x: b.x - a.x, y: b.y - a.y }, ccw);
  const normalBC = outwardNormal({ x: c.x - b.x, y: c.y - b.y }, ccw);
  const normalCA = outwardNormal({ x: a.x - c.x, y: a.y - c.y }, ccw);
  return [
    expandCorner(a, center, normalCA, normalAB, margin),
    expandCorner(b, center, normalAB, normalBC, margin),
    expandCorner(c, center, normalBC, normalCA, margin)
  ];
}

export function textureLikeSize(texture = null) {
  const image = texture?.image || texture?.source?.data || null;
  return {
    width: Math.max(1, Math.floor(Number(image?.width) || Number(texture?.width) || 1)),
    height: Math.max(1, Math.floor(Number(image?.height) || Number(texture?.height) || 1))
  };
}
