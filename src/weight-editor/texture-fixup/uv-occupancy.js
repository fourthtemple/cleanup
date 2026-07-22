import { textureFixupCanvasContext } from "./canvas.js";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function vertexIndexAt(geometry = null, elementIndex = 0) {
  const index = geometry?.index || null;
  if (index && typeof index.getX === "function") {
    return Math.max(0, Math.floor(Number(index.getX(elementIndex)) || 0));
  }
  return Math.max(0, Math.floor(Number(elementIndex) || 0));
}

function triangleMaterialIndex(geometry = null, elementStart = 0) {
  for (const group of geometry?.groups || []) {
    const start = Math.max(0, Math.floor(Number(group?.start) || 0));
    const count = Math.max(0, Math.floor(Number(group?.count) || 0));
    if (elementStart >= start && elementStart < start + count) {
      return Math.max(0, Math.floor(Number(group?.materialIndex) || 0));
    }
  }
  return 0;
}

function materialIndicesForObject(object = null, material = null) {
  const materials = Array.isArray(object?.material) ? object.material : [object?.material];
  const indices = new Set();
  for (let index = 0; index < materials.length; index += 1) {
    const candidate = materials[index];
    if (
      candidate === material
      || (
        candidate?.uuid
        && material?.uuid
        && candidate.uuid === material.uuid
      )
    ) {
      indices.add(index);
    }
  }
  return indices;
}

function transformedUv(uvAttribute, vertexIndex, texture, width, height) {
  let x = finiteNumber(uvAttribute?.getX?.(vertexIndex), NaN);
  let y = finiteNumber(uvAttribute?.getY?.(vertexIndex), NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  if (texture?.matrixAutoUpdate !== false && typeof texture?.updateMatrix === "function") {
    texture.updateMatrix();
  }
  const elements = texture?.matrix?.elements || null;
  if (elements?.length >= 9) {
    const transformedX = elements[0] * x + elements[3] * y + elements[6];
    const transformedY = elements[1] * x + elements[4] * y + elements[7];
    x = transformedX;
    y = transformedY;
  }
  const flipY = texture?.flipY === true
    || texture?.userData?.texturePaintTslSurfaceDisplayFlipY === true;
  return {
    x: x * width,
    y: (flipY ? 1 - y : y) * height
  };
}

function triangleArea2(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function rasterizeTriangle(occupancy, width, height, a, b, c) {
  const area = triangleArea2(a, b, c);
  if (!Number.isFinite(area) || Math.abs(area) <= 0.0000001) {
    return false;
  }
  const sign = area < 0 ? -1 : 1;
  const minimumX = Math.max(0, Math.ceil(Math.min(a.x, b.x, c.x) - 0.5));
  const maximumX = Math.min(width - 1, Math.floor(Math.max(a.x, b.x, c.x) - 0.5));
  const minimumY = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
  const maximumY = Math.min(height - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
  let written = false;
  for (let y = minimumY; y <= maximumY; y += 1) {
    const pointY = y + 0.5;
    for (let x = minimumX; x <= maximumX; x += 1) {
      const point = { x: x + 0.5, y: pointY };
      if (
        triangleArea2(a, b, point) * sign < -0.000001
        || triangleArea2(b, c, point) * sign < -0.000001
        || triangleArea2(c, a, point) * sign < -0.000001
      ) {
        continue;
      }
      occupancy[y * width + x] = 255;
      written = true;
    }
  }
  if (!written) {
    const x = Math.max(0, Math.min(width - 1, Math.floor((a.x + b.x + c.x) / 3)));
    const y = Math.max(0, Math.min(height - 1, Math.floor((a.y + b.y + c.y) / 3)));
    occupancy[y * width + x] = 255;
  }
  return true;
}

function rasterizeGeometry(occupancy, width, height, geometry, texture, materialIndices) {
  const position = geometry?.attributes?.position || null;
  const uvAttribute = geometry?.attributes?.uv || null;
  if (!position || !uvAttribute || !materialIndices?.size) {
    return 0;
  }
  const elementCount = geometry.index?.count || position.count || 0;
  let triangleCount = 0;
  for (let elementStart = 0; elementStart + 2 < elementCount; elementStart += 3) {
    if (!materialIndices.has(triangleMaterialIndex(geometry, elementStart))) {
      continue;
    }
    const a = transformedUv(uvAttribute, vertexIndexAt(geometry, elementStart), texture, width, height);
    const b = transformedUv(uvAttribute, vertexIndexAt(geometry, elementStart + 1), texture, width, height);
    const c = transformedUv(uvAttribute, vertexIndexAt(geometry, elementStart + 2), texture, width, height);
    if (a && b && c && rasterizeTriangle(occupancy, width, height, a, b, c)) {
      triangleCount += 1;
    }
  }
  return triangleCount;
}

export function textureFixupMaterialUvOccupancy(
  editor,
  material,
  texture,
  width,
  height
) {
  const outputWidth = Math.max(1, Math.floor(Number(width) || 1));
  const outputHeight = Math.max(1, Math.floor(Number(height) || 1));
  const occupancy = new Uint8Array(outputWidth * outputHeight);
  let triangleCount = 0;
  editor?.model?.traverse?.((object) => {
    const materialIndices = materialIndicesForObject(object, material);
    triangleCount += rasterizeGeometry(
      occupancy,
      outputWidth,
      outputHeight,
      object?.geometry,
      texture,
      materialIndices
    );
  });
  return triangleCount > 0
    ? { data: occupancy, width: outputWidth, height: outputHeight, triangleCount }
    : null;
}

export function textureFixupClipMaskToUvOccupancy(maskCanvas = null, occupancy = null) {
  const context = textureFixupCanvasContext(maskCanvas, { willReadFrequently: true });
  if (
    !maskCanvas
    || !context
    || !occupancy?.data
    || occupancy.width !== maskCanvas.width
    || occupancy.height !== maskCanvas.height
    || occupancy.data.length < maskCanvas.width * maskCanvas.height
  ) {
    return null;
  }
  const image = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  let removedPixelCount = 0;
  let retainedPixelCount = 0;
  for (let pixelIndex = 0; pixelIndex < maskCanvas.width * maskCanvas.height; pixelIndex += 1) {
    const alphaOffset = pixelIndex * 4 + 3;
    const alpha = image.data[alphaOffset];
    if (!alpha) {
      continue;
    }
    if (!occupancy.data[pixelIndex]) {
      image.data[alphaOffset] = 0;
      removedPixelCount += 1;
    } else {
      retainedPixelCount += 1;
    }
  }
  context.putImageData(image, 0, 0);
  return { removedPixelCount, retainedPixelCount };
}

export function textureFixupClipMaskToMaterialUvOccupancy(
  editor,
  maskCanvas,
  material,
  texture
) {
  const occupancy = textureFixupMaterialUvOccupancy(
    editor,
    material,
    texture,
    maskCanvas?.width,
    maskCanvas?.height
  );
  if (!occupancy) {
    return null;
  }
  const result = textureFixupClipMaskToUvOccupancy(maskCanvas, occupancy);
  return result ? { ...result, triangleCount: occupancy.triangleCount } : null;
}
