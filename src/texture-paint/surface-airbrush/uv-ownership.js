export const SURFACE_UV_OWNERSHIP_MASK_SIZE = 1024;
export const SURFACE_UV_OWNERSHIP_DISTANCE_THRESHOLD = 0.25;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function triangleArea2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function vertexIndexAt(geometry = null, elementIndex = 0) {
  const index = geometry?.index || null;
  if (index && typeof index.getX === "function") {
    return Math.max(0, Math.floor(Number(index.getX(elementIndex)) || 0));
  }
  return Math.max(0, Math.floor(Number(elementIndex) || 0));
}

function uvTriangleContainsPoint(point = null, triangle = null) {
  if (!point || !triangle?.uvs?.length) {
    return false;
  }
  const [a, b, c] = triangle.uvs;
  const area = triangleArea2(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) <= 0.000000000001) {
    return false;
  }
  const sign = Math.sign(area) || 1;
  return (
    triangleArea2(a, b, point) * sign >= -0.0000001
    && triangleArea2(b, c, point) * sign >= -0.0000001
    && triangleArea2(c, a, point) * sign >= -0.0000001
  );
}

function positionKey(point = null, scale = 10000) {
  return [
    Math.round(finiteNumber(point?.x, 0) * scale),
    Math.round(finiteNumber(point?.y, 0) * scale),
    Math.round(finiteNumber(point?.z, 0) * scale)
  ].join(",");
}

function trianglesShareSurfaceEdge(left = null, right = null) {
  if (!left || !right) {
    return false;
  }
  const leftIndices = new Set(left.vertexIndices || []);
  const sharedIndices = (right.vertexIndices || []).filter((index) => leftIndices.has(index)).length;
  if (sharedIndices >= 2) {
    return true;
  }
  const leftPositions = new Set(left.positionKeys || []);
  const sharedPositions = (right.positionKeys || []).filter((key) => leftPositions.has(key)).length;
  return sharedPositions >= 2;
}

function trianglesHaveAmbiguousUvOverlap(left = null, right = null) {
  return Boolean(left && right && left !== right && !trianglesShareSurfaceEdge(left, right));
}

function ownershipTriangles(geometry = null) {
  const position = geometry?.attributes?.position || null;
  const uvAttribute = geometry?.attributes?.uv || null;
  if (!geometry || !position || !uvAttribute) {
    return [];
  }
  const elementCount = geometry.index?.count || position.count || 0;
  const triangles = [];
  for (let elementStart = 0; elementStart + 2 < elementCount; elementStart += 3) {
    const vertexIndices = [
      vertexIndexAt(geometry, elementStart),
      vertexIndexAt(geometry, elementStart + 1),
      vertexIndexAt(geometry, elementStart + 2)
    ];
    const uvs = vertexIndices.map((index) => ({
      x: finiteNumber(uvAttribute.getX(index), 0),
      y: finiteNumber(uvAttribute.getY(index), 0)
    }));
    if (Math.abs(triangleArea2(uvs[0], uvs[1], uvs[2])) <= 0.000000000001) {
      continue;
    }
    const points = vertexIndices.map((index) => ({
      x: finiteNumber(position.getX(index), 0),
      y: finiteNumber(position.getY(index), 0),
      z: finiteNumber(position.getZ(index), 0)
    }));
    triangles.push({
      vertexIndices,
      positionKeys: points.map((point) => positionKey(point)),
      uvs,
      minU: Math.min(uvs[0].x, uvs[1].x, uvs[2].x),
      maxU: Math.max(uvs[0].x, uvs[1].x, uvs[2].x),
      minV: Math.min(uvs[0].y, uvs[1].y, uvs[2].y),
      maxV: Math.max(uvs[0].y, uvs[1].y, uvs[2].y)
    });
  }
  return triangles;
}

export function surfaceUvOwnershipKey(geometry = null, options = {}) {
  const size = Math.max(1, Math.floor(Number(options.size) || SURFACE_UV_OWNERSHIP_MASK_SIZE));
  return [
    geometry?.uuid || geometry?.id || "geometry",
    Number(geometry?.attributes?.position?.version) || 0,
    Number(geometry?.attributes?.uv?.version) || 0,
    Number(geometry?.index?.version) || 0,
    size,
    SURFACE_UV_OWNERSHIP_DISTANCE_THRESHOLD
  ].join(":");
}

export function buildSurfaceUvOwnershipMask(geometry = null, options = {}) {
  const size = Math.max(1, Math.floor(Number(options.size) || SURFACE_UV_OWNERSHIP_MASK_SIZE));
  const triangles = ownershipTriangles(geometry);
  const owner = new Int32Array(size * size);
  owner.fill(-1);
  const ambiguous = new Uint8Array(size * size);

  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    const triangle = triangles[triangleIndex];
    const minX = Math.max(0, Math.floor(triangle.minU * size));
    const maxX = Math.min(size - 1, Math.floor(triangle.maxU * size));
    const minY = Math.max(0, Math.floor(triangle.minV * size));
    const maxY = Math.min(size - 1, Math.floor(triangle.maxV * size));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const point = { x: (x + 0.5) / size, y: (y + 0.5) / size };
        if (!uvTriangleContainsPoint(point, triangle)) {
          continue;
        }
        const offset = y * size + x;
        const previous = owner[offset];
        if (previous < 0) {
          owner[offset] = triangleIndex;
        } else if (previous !== triangleIndex && trianglesHaveAmbiguousUvOverlap(triangles[previous], triangle)) {
          ambiguous[offset] = 1;
        }
      }
    }
  }

  const expandedAmbiguous = new Uint8Array(ambiguous);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!ambiguous[y * size + x]) {
        continue;
      }
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
            expandedAmbiguous[ny * size + nx] = 1;
          }
        }
      }
    }
  }

  let ambiguousTexels = 0;
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < expandedAmbiguous.length; index += 1) {
    const value = expandedAmbiguous[index] ? 0 : 255;
    ambiguousTexels += value ? 0 : 1;
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { data, size, ambiguousTexels, triangleCount: triangles.length };
}
