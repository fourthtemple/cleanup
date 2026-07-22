import {
  textureFixupClamp as clamp,
  textureFixupFiniteInteger as finiteInteger
} from "./core.js";

export function createTextureFixupCanvas(editor, width, height) {
  const canvas = editor?.createTexturePaintCanvas?.(width, height)
    || (typeof document !== "undefined" ? document.createElement("canvas") : null);
  if (!canvas) {
    return null;
  }
  canvas.width = Math.max(1, finiteInteger(width, 1));
  canvas.height = Math.max(1, finiteInteger(height, 1));
  return canvas;
}

export function textureFixupCanvasContext(canvas, options = {}) {
  return canvas?.getContext?.("2d", options) || null;
}

export function textureFixupForceOpaque(canvas = null) {
  const context = textureFixupCanvasContext(canvas, { willReadFrequently: true });
  if (!canvas || !context) {
    return false;
  }
  try {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 3; offset < image.data.length; offset += 4) {
      image.data[offset] = 255;
    }
    context.putImageData(image, 0, 0);
    return true;
  } catch (error) {
    context.save();
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#000000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
    return true;
  }
}

function textureFixupSourceImageSize(image = null) {
  return {
    width: Math.max(0, finiteInteger(
      image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width,
      0
    )),
    height: Math.max(0, finiteInteger(
      image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height,
      0
    ))
  };
}

function textureFixupEditableCanvasSize(width, height) {
  const maximumSide = Math.max(width, height);
  const scale = maximumSide
    ? Math.max(1, Math.min(4, Math.floor(2048 / maximumSide)))
    : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function textureFixupDrawRawTextureImage(editor, context, image, width, height, targetWidth, targetHeight) {
  const data = image?.data || null;
  const pixelCount = width * height;
  if (!data || data.length < pixelCount) {
    return false;
  }
  const source = createTextureFixupCanvas(editor, width, height);
  const sourceContext = textureFixupCanvasContext(source);
  if (!source || !sourceContext) {
    return false;
  }
  const channels = Math.max(1, Math.min(4, Math.floor(data.length / pixelCount)));
  const pixels = sourceContext.createImageData(width, height);
  const byte = (value) => {
    const number = Number(value) || 0;
    return clamp(Math.round(number >= 0 && number <= 1 ? number * 255 : number), 0, 255);
  };
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const sourceOffset = pixelIndex * channels;
    const targetOffset = pixelIndex * 4;
    const red = byte(data[sourceOffset]);
    pixels.data[targetOffset] = red;
    pixels.data[targetOffset + 1] = channels > 1 ? byte(data[sourceOffset + 1]) : red;
    pixels.data[targetOffset + 2] = channels > 2 ? byte(data[sourceOffset + 2]) : red;
    pixels.data[targetOffset + 3] = channels > 3 ? byte(data[sourceOffset + 3]) : 255;
  }
  sourceContext.putImageData(pixels, 0, 0);
  context.drawImage(source, 0, 0, width, height, 0, 0, targetWidth, targetHeight);
  return true;
}

export function textureFixupReadOnlyTextureSource(editor, material = null) {
  const userData = material?.userData || {};
  const sourceTexture = [
    userData.clonePaintOriginalMap,
    userData.textureAirbrushWebGpuCanvasMap,
    material?.map?.userData?.textureAirbrushWebGpuCanvasMap,
    material?.map
  ].find((texture) => texture?.image) || null;
  const image = sourceTexture?.image || null;
  const sourceSize = textureFixupSourceImageSize(image);
  if (!sourceTexture || !sourceSize.width || !sourceSize.height) {
    return null;
  }
  const canvasSize = textureFixupEditableCanvasSize(sourceSize.width, sourceSize.height);
  const canvas = createTextureFixupCanvas(editor, canvasSize.width, canvasSize.height);
  const context = textureFixupCanvasContext(canvas, { willReadFrequently: true });
  if (!canvas || !context) {
    return null;
  }
  let drawn = false;
  try {
    if (image?.data) {
      drawn = textureFixupDrawRawTextureImage(
        editor,
        context,
        image,
        sourceSize.width,
        sourceSize.height,
        canvas.width,
        canvas.height
      );
    } else {
      context.drawImage(image, 0, 0, sourceSize.width, sourceSize.height, 0, 0, canvas.width, canvas.height);
      drawn = true;
    }
  } catch (error) {
    console.warn("Could not read texture for fixup", error);
  }
  if (!drawn) {
    return null;
  }
  return {
    canvas,
    context,
    texture: sourceTexture,
    editable: null,
    readOnly: true
  };
}

export function textureFixupCropCanvas(editor, sourceCanvas, bounds, maskCanvas = null, options = {}) {
  const crop = createTextureFixupCanvas(
    editor,
    options.outputWidth || bounds?.width,
    options.outputHeight || bounds?.height
  );
  const context = textureFixupCanvasContext(crop);
  if (!crop || !context || !sourceCanvas || !bounds) {
    return null;
  }
  context.clearRect(0, 0, crop.width, crop.height);
  context.save();
  if (options.rotate180 === true) {
    context.translate(crop.width, crop.height);
    context.scale(-1, -1);
  }
  context.drawImage(
    sourceCanvas,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    crop.width,
    crop.height
  );
  if (maskCanvas) {
    context.globalCompositeOperation = "destination-in";
    context.drawImage(
      maskCanvas,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      crop.width,
      crop.height
    );
    context.globalCompositeOperation = "source-over";
  }
  context.restore();
  return crop;
}

export function textureFixupMaskedCropCanvas(
  editor,
  sourceCanvas,
  maskCanvas,
  bounds,
  options = {}
) {
  if (
    !sourceCanvas?.width
    || !sourceCanvas.height
    || !maskCanvas
    || sourceCanvas.width !== maskCanvas.width
    || sourceCanvas.height !== maskCanvas.height
    || !bounds
  ) {
    return null;
  }
  const outputWidth = Math.max(1, finiteInteger(options.outputWidth || bounds.width, 1));
  const outputHeight = Math.max(1, finiteInteger(options.outputHeight || bounds.height, 1));
  const crop = createTextureFixupCanvas(editor, outputWidth, outputHeight);
  const context = textureFixupCanvasContext(crop);
  const sourceContext = textureFixupCanvasContext(sourceCanvas, { willReadFrequently: true });
  const maskContext = textureFixupCanvasContext(maskCanvas, { willReadFrequently: true });
  if (!crop || !context || !sourceContext || !maskContext) {
    return null;
  }
  const sourceImage = sourceContext.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
  const maskImage = maskContext.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
  const outputImage = context.createImageData(crop.width, crop.height);
  const threshold = clamp(finiteInteger(options.alphaThreshold, 8), 1, 255);
  const matte = Array.isArray(options.matteColor) && options.matteColor.length >= 3
    ? options.matteColor.slice(0, 3).map((channel) => clamp(finiteInteger(channel, 128), 0, 255))
    : [128, 128, 128];
  const rotate180 = options.rotate180 === true;
  for (let outputY = 0; outputY < crop.height; outputY += 1) {
    const mappedY = rotate180 ? crop.height - 1 - outputY : outputY;
    const sourceY = clamp(
      Math.floor((mappedY + 0.5) * bounds.height / crop.height),
      0,
      bounds.height - 1
    );
    for (let outputX = 0; outputX < crop.width; outputX += 1) {
      const mappedX = rotate180 ? crop.width - 1 - outputX : outputX;
      const sourceX = clamp(
        Math.floor((mappedX + 0.5) * bounds.width / crop.width),
        0,
        bounds.width - 1
      );
      const sampledIndex = sourceY * bounds.width + sourceX;
      const selected = maskImage.data[sampledIndex * 4 + 3] >= threshold;
      const sourceOffset = sampledIndex * 4;
      const outputOffset = (outputY * crop.width + outputX) * 4;
      outputImage.data[outputOffset] = selected ? sourceImage.data[sourceOffset] : matte[0];
      outputImage.data[outputOffset + 1] = selected ? sourceImage.data[sourceOffset + 1] : matte[1];
      outputImage.data[outputOffset + 2] = selected ? sourceImage.data[sourceOffset + 2] : matte[2];
      outputImage.data[outputOffset + 3] = 255;
    }
  }
  context.putImageData(outputImage, 0, 0);
  return crop;
}

function textureFixupSafeName(value = "texture") {
  return String(value || "texture")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "texture";
}

export function textureFixupDownloadName(selection) {
  const bounds = selection?.bounds || { x: 0, y: 0, width: 1, height: 1 };
  const outputWidth = selection?.cropCanvas?.width || bounds.width;
  const outputHeight = selection?.cropCanvas?.height || bounds.height;
  const materialName = textureFixupSafeName(selection?.material?.name || selection?.record?.object?.name || "texture");
  return `${materialName}-fixup-${bounds.x}-${bounds.y}-${outputWidth}x${outputHeight}.png`;
}

let textureFixupPngCrcTable = null;

function textureFixupPngCrc32(bytes) {
  if (!textureFixupPngCrcTable) {
    textureFixupPngCrcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      textureFixupPngCrcTable[value] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = textureFixupPngCrcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function textureFixupPngChunk(type, data = new Uint8Array()) {
  const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0));
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, textureFixupPngCrc32(chunk.subarray(4, data.length + 8)));
  return chunk;
}

function textureFixupCanvasBlobFallback(canvas) {
  return new Promise((resolve, reject) => {
    if (!canvas?.toBlob) {
      reject(new Error("PNG export is unavailable in this browser"));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not encode the texture crop"));
      }
    }, "image/png");
  });
}

export async function textureFixupCanvasBlob(canvas) {
  if (typeof CompressionStream !== "function" || typeof Response !== "function") {
    return textureFixupCanvasBlobFallback(canvas);
  }
  const context = textureFixupCanvasContext(canvas, { willReadFrequently: true });
  if (!canvas || !context) {
    throw new Error("PNG export is unavailable in this browser");
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const stride = canvas.width * 3 + 1;
  const raw = new Uint8Array(stride * canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    for (let x = 0; x < canvas.width; x += 1) {
      const sourceOffset = (y * canvas.width + x) * 4;
      const targetOffset = rowOffset + 1 + x * 3;
      raw[targetOffset] = image.data[sourceOffset];
      raw[targetOffset + 1] = image.data[sourceOffset + 1];
      raw[targetOffset + 2] = image.data[sourceOffset + 2];
    }
  }
  const compressedStream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, canvas.width);
  headerView.setUint32(4, canvas.height);
  header[8] = 8;
  header[9] = 2;
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Blob([
    signature,
    textureFixupPngChunk("IHDR", header),
    textureFixupPngChunk("IDAT", compressed),
    textureFixupPngChunk("IEND")
  ], { type: "image/png" });
}

export async function textureFixupDecodeImage(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }
  if (typeof Image !== "function" || typeof URL === "undefined") {
    throw new Error("Image import is unavailable in this browser");
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not read the imported image"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function textureFixupImageSize(image) {
  return {
    width: Math.max(1, finiteInteger(image?.naturalWidth || image?.videoWidth || image?.width, 1)),
    height: Math.max(1, finiteInteger(image?.naturalHeight || image?.videoHeight || image?.height, 1))
  };
}
