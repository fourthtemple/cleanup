export function sourceRasterTopologySeedVertices(options = {}) {
  const vertices = options.sourceRasterTopologySeedVertices;
  if (vertices instanceof Set) {
    return vertices;
  }
  if (Array.isArray(vertices) || ArrayBuffer.isView(vertices)) {
    return new Set(
      [...vertices]
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isInteger(value) && value >= 0)
    );
  }
  return null;
}

export function sourceRasterTopologyKey(options = {}) {
  const vertices = sourceRasterTopologySeedVertices(options);
  if (!vertices?.size) {
    return "";
  }
  return [
    String(options.sourceRasterTopologyKey || "neighbor"),
    Math.max(0, Math.floor(Number(options.sourceRasterTopologySerial)) || 0),
    vertices.size
  ].join(":");
}

export function sourceRasterVisibleFaceSet(entries = [], record = null, seedFaceIndex = -1) {
  const faces = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (record && entry?.record !== record) {
      continue;
    }
    const faceIndex = Math.floor(Number(entry?.faceIndex));
    if (Number.isInteger(faceIndex) && faceIndex >= 0) {
      faces.add(faceIndex);
    }
  }
  const seed = Math.floor(Number(seedFaceIndex));
  if (Number.isInteger(seed) && seed >= 0) {
    faces.add(seed);
  }
  return faces;
}

export function sourceRasterVisibleFaceIndices(options = {}) {
  const faces = options.sourceRasterVisibleFaceIndices;
  if (faces instanceof Set) {
    return faces;
  }
  if (Array.isArray(faces) || ArrayBuffer.isView(faces)) {
    return new Set(
      [...faces]
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isInteger(value) && value >= 0)
    );
  }
  return null;
}

export function sourceRasterVisibleFaceKey(options = {}) {
  const faces = sourceRasterVisibleFaceIndices(options);
  if (!faces?.size) {
    return "";
  }
  let sum = 0;
  let xor = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const faceIndex of faces) {
    sum = (sum + faceIndex) >>> 0;
    xor ^= faceIndex;
    min = Math.min(min, faceIndex);
    max = Math.max(max, faceIndex);
  }
  return [
    String(options.sourceRasterVisibleFaceKey || "visible"),
    faces.size,
    sum,
    xor >>> 0,
    min,
    max
  ].join(":");
}

export function sourceRasterTriangleAllowsVisibleFace(faceIndex = -1, options = {}) {
  const faces = sourceRasterVisibleFaceIndices(options);
  if (!faces?.size) {
    return true;
  }
  const index = Math.floor(Number(faceIndex));
  return Number.isInteger(index) && index >= 0 && faces.has(index);
}

export function locallyConnectedSourceRasterTriangles(triangles = [], componentState = null, options = {}) {
  const seedVertices = sourceRasterTopologySeedVertices(options);
  if (!seedVertices?.size || !Array.isArray(triangles) || !triangles.length) {
    return triangles;
  }
  const trianglesByVertex = new Map();
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    for (const vertexIndex of triangles[triangleIndex]?.vertexIndices || []) {
      const indexes = trianglesByVertex.get(vertexIndex) || [];
      indexes.push(triangleIndex);
      trianglesByVertex.set(vertexIndex, indexes);
    }
  }
  const seamMap = componentState?.seamMap instanceof Map ? componentState.seamMap : null;
  const linkedVertices = (vertexIndex) => seamMap?.get(vertexIndex) || [vertexIndex];
  const seedTriangleIndexes = new Set();
  for (const seedVertexIndex of seedVertices) {
    for (const linkedIndex of linkedVertices(seedVertexIndex)) {
      for (const triangleIndex of trianglesByVertex.get(linkedIndex) || []) {
        seedTriangleIndexes.add(triangleIndex);
      }
    }
  }
  if (!seedTriangleIndexes.size) {
    return [];
  }
  const connected = new Set(seedTriangleIndexes);
  const queue = [...seedTriangleIndexes];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const triangle = triangles[queue[queueIndex]];
    for (const vertexIndex of triangle?.vertexIndices || []) {
      for (const linkedIndex of linkedVertices(vertexIndex)) {
        for (const candidateIndex of trianglesByVertex.get(linkedIndex) || []) {
          if (connected.has(candidateIndex)) {
            continue;
          }
          connected.add(candidateIndex);
          queue.push(candidateIndex);
        }
      }
    }
  }
  const filtered = triangles.filter((_triangle, triangleIndex) => connected.has(triangleIndex));
  return filtered;
}
