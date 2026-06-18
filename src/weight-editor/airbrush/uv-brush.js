import {
  airbrushCoverageForDistance,
  clampByte,
  isBrightArtifactPixel
} from "./math.js";
import { installTextureAirbrushNearBrushMethods } from "./uv-near.js";

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
      const image = options.paintState?.image || context.getImageData(0, 0, canvas.width, canvas.height);
      const written = options.paintState?.written || new Set();
      let changed = 0;

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const texturePoint = { x, y };
          const screenPoint = this.clonePaintTransformPoint?.(textureToScreen, texturePoint);
          if (!screenPoint) {
            continue;
          }
          const dx = screenPoint.x - pointer.x;
          const dy = screenPoint.y - pointer.y;
          const distanceSq = dx * dx + dy * dy;
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
          if (written.has(key)) {
            continue;
          }
          written.add(key);
          const distance = Math.sqrt(distanceSq);
          const coverage = airbrushCoverageForDistance(distance, brushRadius, scatter, hardness);
          const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
          const brightArtifact = isBrightArtifactPixel(image.data, offset);
          const alpha = brightArtifact
            ? Math.min(1, Math.max(0.32, opacity * strength * Math.min(1, coverage + 0.28)))
            : Math.min(1, opacity * strength * coverage);
          if (alpha <= 0.008) {
            continue;
          }
          const nextR = clampByte(image.data[offset] * (1 - alpha) + color.r * alpha);
          const nextG = clampByte(image.data[offset + 1] * (1 - alpha) + color.g * alpha);
          const nextB = clampByte(image.data[offset + 2] * (1 - alpha) + color.b * alpha);
          const nextA = Math.max(image.data[offset + 3], 255);
          if (
            image.data[offset] === nextR
            && image.data[offset + 1] === nextG
            && image.data[offset + 2] === nextB
            && image.data[offset + 3] === nextA
          ) {
            continue;
          }
          image.data[offset] = nextR;
          image.data[offset + 1] = nextG;
          image.data[offset + 2] = nextB;
          image.data[offset + 3] = nextA;
          changed += 1;
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
        this.refreshCloneSpotlightTextures?.(record);
        this.updateClonePaintPreviews?.();
        if (options.status !== false) {
          this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
        }
      }
      return changed;
    }
  });
}
