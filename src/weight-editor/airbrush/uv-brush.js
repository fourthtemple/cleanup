import {
  airbrushCoverageForDistance,
  clampByte,
  isBrightArtifactPixel
} from "./math.js";
import { installTextureAirbrushNearBrushMethods } from "./uv-near.js";

function finiteScreenPoint(point = null, rect = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  return {
    x: point.clientX - (rect?.left || 0),
    y: point.clientY - (rect?.top || 0)
  };
}

function screenStrokeSegmentsFromOptions(options = {}, rect = null, pointer = null) {
  const segments = Array.isArray(options.strokeSegments) ? options.strokeSegments : [];
  const result = [];
  for (const segment of segments) {
    const start = finiteScreenPoint(segment?.start, rect);
    const end = finiteScreenPoint(segment?.end, rect);
    if (!start || !end) {
      continue;
    }
    result.push({ start, end });
  }
  if (!result.length && pointer) {
    result.push({ start: pointer, end: pointer });
  }
  return result;
}

function distanceSqToSegment(point = null, segment = null, radiusSq = Infinity) {
  const start = segment?.start;
  const end = segment?.end;
  if (
    !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || !Number.isFinite(start?.x)
    || !Number.isFinite(start?.y)
    || !Number.isFinite(end?.x)
    || !Number.isFinite(end?.y)
  ) {
    return Infinity;
  }
  const radius = Math.sqrt(Math.max(0, radiusSq));
  if (
    point.x < Math.min(start.x, end.x) - radius
    || point.x > Math.max(start.x, end.x) + radius
    || point.y < Math.min(start.y, end.y) - radius
    || point.y > Math.max(start.y, end.y) + radius
  ) {
    return Infinity;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0.0001
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq))
    : 0;
  const closestX = start.x + dx * t;
  const closestY = start.y + dy * t;
  const pointDx = point.x - closestX;
  const pointDy = point.y - closestY;
  return pointDx * pointDx + pointDy * pointDy;
}

function distanceSqToStrokePath(point = null, segments = [], fallback = null, radiusSq = Infinity) {
  let best = Infinity;
  for (const segment of segments) {
    const distanceSq = distanceSqToSegment(point, segment, radiusSq);
    if (distanceSq < best) {
      best = distanceSq;
      if (best <= 0.0001) {
        break;
      }
    }
  }
  if (best !== Infinity || !fallback) {
    return best;
  }
  const dx = point.x - fallback.x;
  const dy = point.y - fallback.y;
  return dx * dx + dy * dy;
}

function imageDataMatchesCanvas(image = null, canvas = null) {
  return Boolean(
    image?.data
    && canvas
    && image.width === canvas.width
    && image.height === canvas.height
  );
}

function writeTexturePixelFromSource(image, offset, sourceData, color, alpha) {
  const nextR = clampByte(sourceData[offset] * (1 - alpha) + color.r * alpha);
  const nextG = clampByte(sourceData[offset + 1] * (1 - alpha) + color.g * alpha);
  const nextB = clampByte(sourceData[offset + 2] * (1 - alpha) + color.b * alpha);
  const nextA = Math.max(sourceData[offset + 3], 255);
  if (
    image.data[offset] === nextR
    && image.data[offset + 1] === nextG
    && image.data[offset + 2] === nextB
    && image.data[offset + 3] === nextA
  ) {
    return false;
  }
  image.data[offset] = nextR;
  image.data[offset + 1] = nextG;
  image.data[offset + 2] = nextB;
  image.data[offset + 3] = nextA;
  return true;
}

function writeLayerPixelFromSource(image, offset, sourceData, color, amount, options = {}) {
  const previousA = (sourceData[offset + 3] || 0) / 255;
  if (options.erase === true) {
    const nextA = clampByte(previousA * (1 - amount) * 255);
    if (image.data[offset + 3] === nextA) {
      return false;
    }
    image.data[offset] = nextA === 0 ? 0 : sourceData[offset];
    image.data[offset + 1] = nextA === 0 ? 0 : sourceData[offset + 1];
    image.data[offset + 2] = nextA === 0 ? 0 : sourceData[offset + 2];
    image.data[offset + 3] = nextA;
    return true;
  }
  const nextAFloat = amount + previousA * (1 - amount);
  if (nextAFloat <= 0) {
    return false;
  }
  const previousWeight = previousA * (1 - amount);
  const nextR = clampByte((color.r * amount + sourceData[offset] * previousWeight) / nextAFloat);
  const nextG = clampByte((color.g * amount + sourceData[offset + 1] * previousWeight) / nextAFloat);
  const nextB = clampByte((color.b * amount + sourceData[offset + 2] * previousWeight) / nextAFloat);
  const nextA = clampByte(nextAFloat * 255);
  if (
    image.data[offset] === nextR
    && image.data[offset + 1] === nextG
    && image.data[offset + 2] === nextB
    && image.data[offset + 3] === nextA
  ) {
    return false;
  }
  image.data[offset] = nextR;
  image.data[offset + 1] = nextG;
  image.data[offset + 2] = nextB;
  image.data[offset + 3] = nextA;
  return true;
}

export function installTextureAirbrushUvBrushMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;
  installTextureAirbrushNearBrushMethods(BirdWeightEditor);

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushRegionPixelFromUv(uv, canvas, texture, referenceUv = null) {
      if (!uv) {
        return null;
      }
      const mapped = this.clonePaintTextureUv(uv, texture);
      if (referenceUv) {
        const referenceMapped = this.clonePaintTextureUv(referenceUv, texture);
        mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
        mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
        return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, { wrap: false });
      }
      return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture);
    },

    textureAirbrushUvBrushOnFace(record, hit, event, options = {}) {
      const face = hit?.face;
      if (!record || !face || !event || !this.canvas || !this.camera) {
        return 0;
      }
      const position = record.geometry.attributes.position;
      const uvAttribute = record.geometry.attributes.uv;
      if (!position || !uvAttribute) {
        return 0;
      }
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      if (!material || !editable) {
        return 0;
      }

      const rect = this.canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const radiusSq = brushRadius * brushRadius;
      const strokeSegments = screenStrokeSegmentsFromOptions(options, rect, pointer);
      const target = options.target || null;
      const referenceUv = options.referenceUv || target?.originUv || target?.uvCenter || hit.uv || face.centerUv || null;
      const { canvas, context, texture } = editable;
      const materialIndex = face.materialIndex ?? target?.originMaterialIndex ?? target?.materialIndex ?? 0;

      const vertexIndices = face.vertices || [face.a, face.b, face.c];
      if (vertexIndices.length !== 3) {
        return 0;
      }

      this.model?.updateMatrixWorld?.(true);
      record.object.updateMatrixWorld(true);

      const screenPoints = [];
      const texturePoints = [];
      for (const vertexIndex of vertexIndices) {
        if (!Number.isInteger(vertexIndex) || record.deleted?.has(vertexIndex)) {
          return 0;
        }
        const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform?.(record.object, vertexIndex, local);
        record.object.localToWorld(local);
        const projected = local.project(this.camera);
        if (projected.z < -1 || projected.z > 1) {
          return 0;
        }
        screenPoints.push({
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height
        });
        const uv = new THREE.Vector2(
          uvAttribute.getX(vertexIndex),
          uvAttribute.getY(vertexIndex)
        );
        texturePoints.push(this.textureAirbrushRegionPixelFromUv(
          uv,
          canvas,
          texture,
          referenceUv
        ));
      }
      if (texturePoints.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        return 0;
      }

      const closest = this.texturePaintClosestTrianglePoint?.(pointer, screenPoints);
      if (!closest || closest.distanceSq > radiusSq) {
        return 0;
      }

      const textureToScreen = this.clonePaintTriangleTransform?.(texturePoints, screenPoints);
      if (!textureToScreen) {
        return 0;
      }
      const screenToTexture = this.clonePaintTriangleTransform?.(screenPoints, texturePoints);
      const center = hit.uv
        ? this.textureAirbrushRegionPixelFromUv(hit.uv, canvas, texture, referenceUv)
        : this.clonePaintTransformPoint?.(
          screenToTexture,
          pointer
        );
      if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
        return 0;
      }

      const regionTriangles = options.regionTriangles || (
        target?.vertices?.size
          ? this.clonePaintRegionTextureTriangles?.(
            record,
            target,
            materialIndex,
            canvas,
            texture,
            { referenceUv }
          ) || []
          : null
      );
      if (target?.vertices?.size && !regionTriangles?.length) {
        return 0;
      }

      const textureBoundsSamples = screenToTexture
        ? [
          pointer,
          { x: pointer.x - brushRadius, y: pointer.y },
          { x: pointer.x + brushRadius, y: pointer.y },
          { x: pointer.x, y: pointer.y - brushRadius },
          { x: pointer.x, y: pointer.y + brushRadius },
          { x: pointer.x - brushRadius * 0.707, y: pointer.y - brushRadius * 0.707 },
          { x: pointer.x + brushRadius * 0.707, y: pointer.y - brushRadius * 0.707 },
          { x: pointer.x - brushRadius * 0.707, y: pointer.y + brushRadius * 0.707 },
          { x: pointer.x + brushRadius * 0.707, y: pointer.y + brushRadius * 0.707 }
        ]
          .map((point) => this.clonePaintTransformPoint?.(screenToTexture, point))
          .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
        : [center];
      if (!textureBoundsSamples.length) {
        return 0;
      }
      const maxTextureRadius = Math.max(24, Math.min(768, Math.max(canvas.width, canvas.height) * 0.5));
      const rawMinX = Math.min(...textureBoundsSamples.map((point) => point.x));
      const rawMaxX = Math.max(...textureBoundsSamples.map((point) => point.x));
      const rawMinY = Math.min(...textureBoundsSamples.map((point) => point.y));
      const rawMaxY = Math.max(...textureBoundsSamples.map((point) => point.y));
      const minX = Math.floor(Math.max(center.x - maxTextureRadius, rawMinX - 3));
      const maxX = Math.ceil(Math.min(center.x + maxTextureRadius, rawMaxX + 3));
      const minY = Math.floor(Math.max(center.y - maxTextureRadius, rawMinY - 3));
      const maxY = Math.ceil(Math.min(center.y + maxTextureRadius, rawMaxY + 3));
      const color = this.textureAirbrushColor();
      const strength = options.strength ?? 1;
      const opacity = options.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42;
      const hardness = options.hardness ?? this.textureAirbrushHardness?.() ?? 0.35;
      const scatter = options.scatter ?? this.textureAirbrushScatter?.() ?? 0.35;
      const image = options.paintState?.image || context.getImageData(0, 0, canvas.width, canvas.height);
      const sourceImage = imageDataMatchesCanvas(options.paintState?.sourceImage, canvas)
        ? options.paintState.sourceImage
        : null;
      const sourceData = sourceImage?.data || null;
      if (sourceData && options.paintState && !options.paintState.strokeAlphaByPixel) {
        options.paintState.strokeAlphaByPixel = new Map();
      }
      const strokeAlphaByPixel = sourceData
        ? options.paintState?.strokeAlphaByPixel || null
        : null;
      const written = options.paintState?.written || new Set();
      let dirtyBounds = options.paintState?.dirtyBounds || null;
      const markDirtyPixel = (x, y) => {
        dirtyBounds = dirtyBounds
          ? {
              minX: Math.min(dirtyBounds.minX, x),
              minY: Math.min(dirtyBounds.minY, y),
              maxX: Math.max(dirtyBounds.maxX, x),
              maxY: Math.max(dirtyBounds.maxY, y)
            }
          : {
              minX: x,
              minY: y,
              maxX: x,
              maxY: y
            };
        if (options.paintState) {
          options.paintState.dirtyBounds = dirtyBounds;
        }
      };
      let changed = 0;
      const useLayerPixels = editable.layerMode === true;
      const eraseLayer = useLayerPixels && options.erase === true;

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const texturePoint = { x, y };
          const screenPoint = this.clonePaintTransformPoint?.(textureToScreen, texturePoint);
          if (!screenPoint) {
            continue;
          }
          const distanceSq = distanceSqToStrokePath(screenPoint, strokeSegments, pointer, radiusSq);
          if (distanceSq > radiusSq) {
            continue;
          }
          const faceBarycentric = this.clonePaintBarycentric(texturePoint, texturePoints);
          if (!this.clonePaintBarycentricInside(faceBarycentric, 0.025)) {
            continue;
          }
          if (
            regionTriangles
            && !this.clonePaintPointInsideTextureTriangles?.(texturePoint, regionTriangles, 0.035)
          ) {
            continue;
          }
          const actualPixel = this.clonePaintActualPixelFromTexturePoint?.(texturePoint, canvas, texture);
          if (!actualPixel) {
            continue;
          }
          const key = `${actualPixel.x}:${actualPixel.y}`;
          const distance = Math.sqrt(distanceSq);
          const coverage = airbrushCoverageForDistance(distance, brushRadius, scatter, hardness);
          const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
          const brightArtifact = isBrightArtifactPixel(sourceData || image.data, offset);
          const alpha = brightArtifact
            ? Math.min(1, Math.max(0.32, opacity * strength * Math.min(1, coverage + 0.28)))
            : Math.min(1, opacity * strength * coverage);
          if (alpha <= 0.008) {
            continue;
          }
          if (strokeAlphaByPixel) {
            const previousAlpha = strokeAlphaByPixel.get(key) || 0;
            if (alpha <= previousAlpha + 0.0005) {
              continue;
            }
            strokeAlphaByPixel.set(key, alpha);
          } else {
            if (written.has(key)) {
              continue;
            }
            written.add(key);
          }
          let pixelChanged = false;
          if (useLayerPixels) {
            pixelChanged = sourceData
              ? writeLayerPixelFromSource(image, offset, sourceData, color, alpha, { erase: eraseLayer })
              : this.texturePaintApplyLayerPixel?.(image, offset, color, alpha, { erase: eraseLayer }) === true;
          } else {
            pixelChanged = sourceData
              ? writeTexturePixelFromSource(image, offset, sourceData, color, alpha)
              : writeTexturePixelFromSource(image, offset, image.data, color, alpha);
          }
          if (!pixelChanged) {
            continue;
          }
          changed += 1;
          markDirtyPixel(actualPixel.x, actualPixel.y);
        }
      }

      if (!changed) {
        return 0;
      }
      if (options.paintState) {
        options.paintState.changed = (options.paintState.changed || 0) + changed;
      }
      if (!options.deferCommit) {
        context.putImageData(image, 0, 0);
        texture.needsUpdate = true;
        material.needsUpdate = true;
        if (editable.layerMode && dirtyBounds) {
          editable.dirtyBounds = dirtyBounds;
        }
        this.texturePaintCommitEditable?.(editable, material, record, {
          refreshSpotlight: editable.layerMode !== true
        });
        if (editable.layerMode) {
          delete editable.dirtyBounds;
        }
        this.markTexturePaintStrokeChanged?.();
        if (editable.layerMode !== true) {
          this.refreshCloneSpotlightTextures?.(record);
          this.updateClonePaintPreviews?.();
        }
        if (options.status !== false) {
          this.setStatus(`${eraseLayer ? "Erased" : "Airbrushed"} ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
        }
      }
      return changed;
    }
  });
}
