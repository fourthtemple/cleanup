function positiveCanvasSize(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function textureAirbrushImageDataDimensionsMatch(imageData = null, width = 0, height = 0, byteLength = 0) {
  return imageData?.width === width
    && imageData?.height === height
    && imageData?.data?.byteLength === byteLength;
}

function textureAirbrushSetImageDataPixels(imageData = null, pixels = null) {
  if (!imageData?.data || !pixels) {
    return null;
  }
  imageData.data.set(pixels);
  return imageData;
}

function textureAirbrushImageDataFromPixels(pixels, width, height, context = null, reusableImageData = null) {
  const byteLength = positiveCanvasSize(width) * positiveCanvasSize(height) * 4;
  if (textureAirbrushImageDataDimensionsMatch(reusableImageData, width, height, byteLength)) {
    return textureAirbrushSetImageDataPixels(reusableImageData, pixels);
  }
  if (typeof context?.createImageData === "function") {
    const imageData = context.createImageData(width, height);
    return textureAirbrushSetImageDataPixels(imageData, pixels);
  }
  const data = pixels instanceof Uint8ClampedArray
    ? new Uint8ClampedArray(pixels)
    : new Uint8ClampedArray(pixels.buffer || pixels, pixels.byteOffset || 0, pixels.byteLength || pixels.length || 0);
  if (typeof ImageData === "function") {
    return new ImageData(data, width, height);
  }
  return {
    data,
    width,
    height
  };
}

export function textureAirbrushSourcePixelsFromEditable(editable = null) {
  const canvas = editable?.canvas || null;
  const context = editable?.context || null;
  const width = positiveCanvasSize(canvas?.width);
  const height = positiveCanvasSize(canvas?.height);
  if (!canvas || !context || !width || !height || typeof context.getImageData !== "function") {
    return null;
  }
  const imageData = context.getImageData(0, 0, width, height);
  const sourcePixels = new Uint8Array(
    imageData.data.buffer,
    imageData.data.byteOffset || 0,
    imageData.data.byteLength
  );
  return {
    width,
    height,
    imageData,
    sourcePixels
  };
}

export function textureAirbrushEditableCanvasSize(editable = null) {
  const canvas = editable?.canvas || null;
  const width = positiveCanvasSize(canvas?.width);
  const height = positiveCanvasSize(canvas?.height);
  if (!canvas || !width || !height) {
    return null;
  }
  return {
    width,
    height
  };
}

export function textureAirbrushApplyPixelsToEditable(editable = null, pixels = null, {
  imageData = null,
  material = null,
  bounds = null,
  reusableImageData = null
} = {}) {
  const canvas = editable?.canvas || null;
  const context = editable?.context || null;
  const texture = editable?.texture || null;
  const width = positiveCanvasSize(canvas?.width);
  const height = positiveCanvasSize(canvas?.height);
  const x = Math.max(0, Math.min(width - 1, Math.floor(Number(bounds?.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(Number(bounds?.y) || 0)));
  const dirtyWidth = Math.max(1, Math.min(width - x, positiveCanvasSize(bounds?.width || width)));
  const dirtyHeight = Math.max(1, Math.min(height - y, positiveCanvasSize(bounds?.height || height)));
  const byteLength = dirtyWidth * dirtyHeight * 4;
  if (!context || !width || !height || !pixels || pixels.byteLength !== byteLength || typeof context.putImageData !== "function") {
    return null;
  }
  const fullByteLength = width * height * 4;
  if (imageData?.data?.byteLength === fullByteLength && (dirtyWidth !== width || dirtyHeight !== height || x || y)) {
    for (let row = 0; row < dirtyHeight; row += 1) {
      const sourceOffset = row * dirtyWidth * 4;
      const targetOffset = ((y + row) * width + x) * 4;
      imageData.data.set(
        pixels.subarray(sourceOffset, sourceOffset + dirtyWidth * 4),
        targetOffset
      );
    }
    const dirtyImageData = textureAirbrushImageDataFromPixels(pixels, dirtyWidth, dirtyHeight, context, reusableImageData);
    context.putImageData(dirtyImageData, x, y);
    if (texture) {
      texture.needsUpdate = true;
    }
    if (material) {
      material.needsUpdate = true;
    }
    return {
      width: dirtyWidth,
      height: dirtyHeight,
      x,
      y,
      byteLength,
      imageData,
      putImageData: dirtyImageData,
      reusedImageData: dirtyImageData === reusableImageData
    };
  }
  const nextImageData = imageData?.data?.byteLength === byteLength
    ? imageData
    : textureAirbrushImageDataFromPixels(pixels, dirtyWidth, dirtyHeight, context, reusableImageData);
  if (nextImageData !== imageData) {
    context.putImageData(nextImageData, x, y);
  } else {
    nextImageData.data.set(pixels);
    context.putImageData(nextImageData, x, y);
  }
  if (texture) {
    texture.needsUpdate = true;
  }
  if (material) {
    material.needsUpdate = true;
  }
  return {
    width: dirtyWidth,
    height: dirtyHeight,
    x,
    y,
    byteLength,
    imageData: nextImageData,
    putImageData: nextImageData,
    reusedImageData: nextImageData === reusableImageData
  };
}
