import { textureFixupPaddedBounds } from "./core.js";
import {
  createTextureFixupCanvas,
  textureFixupCanvasContext,
  textureFixupForceOpaque,
  textureFixupImageSize
} from "./canvas.js";

function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function unionBounds(first = null, second = null) {
  if (!first) {
    return second ? { ...second } : null;
  }
  if (!second) {
    return { ...first };
  }
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return { x, y, width: right - x, height: bottom - y };
}

function boundsOverlap(first = null, second = null) {
  if (!first || !second) {
    return false;
  }
  return first.x <= second.x + second.width
    && second.x <= first.x + first.width
    && first.y <= second.y + second.height
    && second.y <= first.y + first.height;
}

function mergeOverlappingSources(sources = []) {
  const merged = [];
  for (const source of sources) {
    let group = {
      componentIndexes: [source.index],
      sourceBounds: { ...source.sourceBounds }
    };
    for (let index = 0; index < merged.length;) {
      const existing = merged[index];
      if (!boundsOverlap(group.sourceBounds, existing.sourceBounds)) {
        index += 1;
        continue;
      }
      group = {
        componentIndexes: [...existing.componentIndexes, ...group.componentIndexes],
        sourceBounds: unionBounds(existing.sourceBounds, group.sourceBounds)
      };
      merged.splice(index, 1);
      index = 0;
    }
    merged.push(group);
  }
  return merged;
}

export function textureFixupMaskComponents(editor, maskCanvas = null, options = {}) {
  if (!maskCanvas?.width || !maskCanvas.height) {
    return [];
  }
  const maximumAnalysisSide = positiveInteger(options.maximumAnalysisSide, 512);
  const analysisScale = Math.min(1, maximumAnalysisSide / Math.max(maskCanvas.width, maskCanvas.height));
  const analysisWidth = Math.max(1, Math.ceil(maskCanvas.width * analysisScale));
  const analysisHeight = Math.max(1, Math.ceil(maskCanvas.height * analysisScale));
  const analysis = createTextureFixupCanvas(editor, analysisWidth, analysisHeight);
  const context = textureFixupCanvasContext(analysis, { willReadFrequently: true });
  if (!analysis || !context) {
    return [];
  }
  context.clearRect(0, 0, analysis.width, analysis.height);
  context.imageSmoothingEnabled = true;
  context.drawImage(maskCanvas, 0, 0, maskCanvas.width, maskCanvas.height, 0, 0, analysis.width, analysis.height);
  const image = context.getImageData(0, 0, analysis.width, analysis.height);
  const threshold = Math.max(1, Math.min(255, positiveInteger(options.alphaThreshold, 2)));
  const pixelCount = analysis.width * analysis.height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];

  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (visited[seed] || image.data[seed * 4 + 3] < threshold) {
      continue;
    }
    let head = 0;
    let tail = 0;
    let minimumX = analysis.width;
    let minimumY = analysis.height;
    let maximumX = -1;
    let maximumY = -1;
    let alphaSum = 0;
    let count = 0;
    queue[tail] = seed;
    tail += 1;
    visited[seed] = 1;
    while (head < tail) {
      const pixelIndex = queue[head];
      head += 1;
      const x = pixelIndex % analysis.width;
      const y = Math.floor(pixelIndex / analysis.width);
      const alpha = image.data[pixelIndex * 4 + 3];
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      alphaSum += alpha;
      count += 1;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= analysis.width || nextY >= analysis.height) {
            continue;
          }
          const nextIndex = nextY * analysis.width + nextX;
          if (visited[nextIndex] || image.data[nextIndex * 4 + 3] < threshold) {
            continue;
          }
          visited[nextIndex] = 1;
          queue[tail] = nextIndex;
          tail += 1;
        }
      }
    }
    components.push({ minimumX, minimumY, maximumX, maximumY, alphaSum, count });
  }

  if (!components.length) {
    return [];
  }
  components.sort((left, right) => right.alphaSum - left.alphaSum);
  const maximumAlpha = components[0].alphaSum;
  const minimumRelativeAlpha = Math.max(0, Math.min(0.1, Number(options.minimumRelativeAlpha) || 0.0005));
  const maximumComponents = positiveInteger(options.maximumComponents, 48);
  const scaleX = maskCanvas.width / analysis.width;
  const scaleY = maskCanvas.height / analysis.height;
  const sourceInset = positiveInteger(options.sourceInset, 3);
  return components
    .filter((component) => component.alphaSum >= maximumAlpha * minimumRelativeAlpha)
    .slice(0, maximumComponents)
    .map((component) => {
      const x = Math.max(0, Math.floor(component.minimumX * scaleX) - sourceInset);
      const y = Math.max(0, Math.floor(component.minimumY * scaleY) - sourceInset);
      const right = Math.min(maskCanvas.width, Math.ceil((component.maximumX + 1) * scaleX) + sourceInset);
      const bottom = Math.min(maskCanvas.height, Math.ceil((component.maximumY + 1) * scaleY) + sourceInset);
      return {
        bounds: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
        alphaSum: component.alphaSum,
        pixelCount: component.count
      };
    });
}

export function textureFixupComponentsBounds(components = []) {
  return components.reduce((bounds, component) => unionBounds(bounds, component?.bounds), null);
}

export function textureFixupDominantComponents(components = []) {
  let dominant = null;
  let dominantScore = -1;
  for (const component of components) {
    if (!component?.bounds) {
      continue;
    }
    const boundsArea = component.bounds.width * component.bounds.height;
    const alphaScore = Number(component.alphaSum);
    const score = Number.isFinite(alphaScore) && alphaScore > 0 ? alphaScore : boundsArea;
    if (score > dominantScore) {
      dominant = component;
      dominantScore = score;
    }
  }
  return dominant ? [dominant] : [];
}

export function textureFixupPackComponents(components = [], options = {}) {
  const textureWidth = positiveInteger(options.textureWidth, 1);
  const textureHeight = positiveInteger(options.textureHeight, 1);
  const padding = Math.max(0, Math.floor(Number(options.padding) || 0));
  const gutter = Math.max(0, Math.floor(Number(options.gutter) || 16));
  const paddedSources = components
    .map((component, index) => ({
      index,
      sourceBounds: textureFixupPaddedBounds(component?.bounds, padding, textureWidth, textureHeight)
    }))
    .filter((item) => item.sourceBounds);
  const sources = mergeOverlappingSources(paddedSources)
    .sort((left, right) => (
      right.sourceBounds.height - left.sourceBounds.height
      || right.sourceBounds.width - left.sourceBounds.width
    ));
  if (!sources.length) {
    return null;
  }
  if (sources.length === 1) {
    const source = sources[0];
    return {
      width: source.sourceBounds.width,
      height: source.sourceBounds.height,
      items: [{
        componentIndexes: source.componentIndexes,
        sourceBounds: source.sourceBounds,
        destinationBounds: {
          x: 0,
          y: 0,
          width: source.sourceBounds.width,
          height: source.sourceBounds.height
        }
      }]
    };
  }

  const totalArea = sources.reduce((sum, item) => (
    sum + (item.sourceBounds.width + gutter) * (item.sourceBounds.height + gutter)
  ), 0);
  const widest = Math.max(...sources.map((item) => item.sourceBounds.width));
  const targetWidth = Math.max(widest, Math.ceil(Math.sqrt(totalArea * 1.15)));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let packedWidth = 0;
  const items = [];
  for (const source of sources) {
    const bounds = source.sourceBounds;
    if (x > 0 && x + bounds.width > targetWidth) {
      x = 0;
      y += rowHeight + gutter;
      rowHeight = 0;
    }
    const destinationBounds = { x, y, width: bounds.width, height: bounds.height };
    items.push({
      componentIndexes: source.componentIndexes,
      sourceBounds: bounds,
      destinationBounds
    });
    packedWidth = Math.max(packedWidth, x + bounds.width);
    rowHeight = Math.max(rowHeight, bounds.height);
    x += bounds.width + gutter;
  }
  return {
    width: Math.max(1, packedWidth),
    height: Math.max(1, y + rowHeight),
    items
  };
}

function drawPackedItems(context, sourceCanvas, layout, outputWidth, outputHeight, options = {}) {
  const scaleX = outputWidth / layout.width;
  const scaleY = outputHeight / layout.height;
  const sourceOriginX = Number(options.sourceOriginX) || 0;
  const sourceOriginY = Number(options.sourceOriginY) || 0;
  for (const item of layout.items || []) {
    const source = item.sourceBounds;
    const destination = item.destinationBounds;
    const sourceX = source.x - sourceOriginX;
    const sourceY = source.y - sourceOriginY;
    const x = destination.x * scaleX;
    const y = destination.y * scaleY;
    const width = destination.width * scaleX;
    const height = destination.height * scaleY;
    context.save();
    if (options.rotate180 === true) {
      context.translate(x + width, y + height);
      context.scale(-1, -1);
      context.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        source.width,
        source.height,
        0,
        0,
        width,
        height
      );
    } else {
      context.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        source.width,
        source.height,
        x,
        y,
        width,
        height
      );
    }
    context.restore();
  }
}

export function textureFixupPackedCropCanvas(editor, sourceCanvas, maskCanvas, layout = null, options = {}) {
  const applyMask = options.applyMask !== false;
  if (!layout?.items?.length || (applyMask && !maskCanvas)) {
    return null;
  }
  const outputWidth = positiveInteger(options.outputWidth, layout.width);
  const outputHeight = positiveInteger(options.outputHeight, layout.height);
  const canvas = createTextureFixupCanvas(editor, outputWidth, outputHeight);
  const mask = applyMask ? createTextureFixupCanvas(editor, outputWidth, outputHeight) : null;
  const context = textureFixupCanvasContext(canvas);
  const maskContext = applyMask ? textureFixupCanvasContext(mask) : null;
  if (!canvas || !context || (applyMask && (!mask || !maskContext))) {
    return null;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  maskContext?.clearRect(0, 0, mask.width, mask.height);
  if (sourceCanvas) {
    drawPackedItems(context, sourceCanvas, layout, canvas.width, canvas.height, {
      rotate180: options.rotate180 === true,
      sourceOriginX: options.sourceOriginX,
      sourceOriginY: options.sourceOriginY
    });
  } else {
    context.fillStyle = "#ffffff";
    for (const item of layout.items) {
      const destination = item.destinationBounds;
      context.fillRect(
        destination.x * canvas.width / layout.width,
        destination.y * canvas.height / layout.height,
        destination.width * canvas.width / layout.width,
        destination.height * canvas.height / layout.height
      );
    }
  }
  if (applyMask) {
    drawPackedItems(maskContext, maskCanvas, layout, mask.width, mask.height, {
      rotate180: options.rotate180 === true,
      sourceOriginX: options.maskOriginX,
      sourceOriginY: options.maskOriginY
    });
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = "source-over";
  }
  if (options.forceOpaque === true && !textureFixupForceOpaque(canvas)) {
    return null;
  }
  return canvas;
}

export function textureFixupLayoutOutputBounds(layout = null, item = null, outputWidth = 1, outputHeight = 1) {
  if (!layout || !item?.destinationBounds) {
    return null;
  }
  const destination = item.destinationBounds;
  const scaleX = positiveInteger(outputWidth, 1) / layout.width;
  const scaleY = positiveInteger(outputHeight, 1) / layout.height;
  const x = Math.round(destination.x * scaleX);
  const y = Math.round(destination.y * scaleY);
  const right = Math.round((destination.x + destination.width) * scaleX);
  const bottom = Math.round((destination.y + destination.height) * scaleY);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function textureFixupImportedLayerCanvas(
  editor,
  image,
  maskCanvas,
  layout = null,
  options = {}
) {
  if (!image || !maskCanvas?.width || !maskCanvas.height || !layout?.items?.length) {
    return null;
  }
  const importedSize = textureFixupImageSize(image);
  const importedCanvas = createTextureFixupCanvas(editor, importedSize.width, importedSize.height);
  const importedContext = textureFixupCanvasContext(importedCanvas, { willReadFrequently: true });
  const maskContext = textureFixupCanvasContext(maskCanvas, { willReadFrequently: true });
  const referenceContext = textureFixupCanvasContext(options.referenceCanvas, { willReadFrequently: true });
  const output = createTextureFixupCanvas(editor, maskCanvas.width, maskCanvas.height);
  const outputContext = textureFixupCanvasContext(output);
  if (!importedCanvas || !importedContext || !maskContext || !output || !outputContext) {
    return null;
  }
  importedContext.clearRect(0, 0, importedCanvas.width, importedCanvas.height);
  importedContext.drawImage(image, 0, 0, importedCanvas.width, importedCanvas.height);
  const importedImage = importedContext.getImageData(0, 0, importedCanvas.width, importedCanvas.height);
  const maskImage = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const referenceImage = referenceContext
    && options.referenceCanvas.width === maskCanvas.width
    && options.referenceCanvas.height === maskCanvas.height
    ? referenceContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    : null;
  const outputImage = outputContext.createImageData(output.width, output.height);
  const rotate180 = options.rotate180 === true;
  const alphaThreshold = Math.max(1, Math.min(255, positiveInteger(options.alphaThreshold, 8)));

  for (const item of layout.items) {
    const sourceBounds = item?.sourceBounds || null;
    const importedBounds = textureFixupLayoutOutputBounds(
      layout,
      item,
      importedCanvas.width,
      importedCanvas.height
    );
    if (!sourceBounds || !importedBounds) {
      continue;
    }
    const left = Math.max(0, Math.floor(sourceBounds.x));
    const top = Math.max(0, Math.floor(sourceBounds.y));
    const right = Math.min(output.width, Math.ceil(sourceBounds.x + sourceBounds.width));
    const bottom = Math.min(output.height, Math.ceil(sourceBounds.y + sourceBounds.height));
    for (let textureY = top; textureY < bottom; textureY += 1) {
      const localY = textureY - sourceBounds.y;
      const mappedY = rotate180 ? sourceBounds.height - 1 - localY : localY;
      const importedY = Math.max(
        importedBounds.y,
        Math.min(
          importedBounds.y + importedBounds.height - 1,
          importedBounds.y + Math.floor((mappedY + 0.5) * importedBounds.height / sourceBounds.height)
        )
      );
      for (let textureX = left; textureX < right; textureX += 1) {
        const textureOffset = (textureY * output.width + textureX) * 4;
        const maskAlpha = maskImage.data[textureOffset + 3];
        if (maskAlpha < alphaThreshold) {
          continue;
        }
        const localX = textureX - sourceBounds.x;
        const mappedX = rotate180 ? sourceBounds.width - 1 - localX : localX;
        const importedX = Math.max(
          importedBounds.x,
          Math.min(
            importedBounds.x + importedBounds.width - 1,
            importedBounds.x + Math.floor((mappedX + 0.5) * importedBounds.width / sourceBounds.width)
          )
        );
        const importedOffset = (importedY * importedCanvas.width + importedX) * 4;
        outputImage.data[textureOffset] = importedImage.data[importedOffset];
        outputImage.data[textureOffset + 1] = importedImage.data[importedOffset + 1];
        outputImage.data[textureOffset + 2] = importedImage.data[importedOffset + 2];
        const unchanged = referenceImage
          && importedImage.data[importedOffset] === referenceImage.data[textureOffset]
          && importedImage.data[importedOffset + 1] === referenceImage.data[textureOffset + 1]
          && importedImage.data[importedOffset + 2] === referenceImage.data[textureOffset + 2];
        outputImage.data[textureOffset + 3] = unchanged ? 0 : 255;
      }
    }
  }
  outputContext.putImageData(outputImage, 0, 0);
  return output;
}
