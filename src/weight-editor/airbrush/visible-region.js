import {
  airbrushHaloRadius,
  artifactTintAlpha,
  clampByte,
  isBrightArtifactPixel
} from "./math.js";

export function installTextureAirbrushVisibleRegionMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushVisibleRegionFromEvent(record, event, hit, options = {}) {
      const target = this.clonePaintTargets?.get(record);
      if (!record || !target?.vertices?.size || !event || !this.canvas || !this.camera) {
        return null;
      }
      if (!options.materialPass) {
        const materialIndexes = this.texturePaintVisibleRegionMaterialIndexes?.(record) || [];
        if (materialIndexes.length > 1) {
          const hitMaterialIndex = hit?.face?.materialIndex;
          let totalChanged = 0;
          for (const materialIndex of materialIndexes) {
            const passHit = {
              ...hit,
              face: {
                ...(hit?.face || {}),
                materialIndex
              }
            };
            const changed = this.textureAirbrushVisibleRegionFromEvent?.(record, event, passHit, {
              ...options,
              materialPass: true,
              referenceUv: materialIndex === hitMaterialIndex ? hit?.uv || null : null
            }) || 0;
            totalChanged += changed;
          }
          if (totalChanged > 0) {
            this.setStatus(`Soft airbrushed ${totalChanged} ${totalChanged === 1 ? "pixel" : "pixels"}`);
          }
          return totalChanged || null;
        }
      }
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      if (!editable) {
        return null;
      }

      const rect = this.canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      const scatter = this.textureAirbrushScatter?.() ?? 0.35;
      const haloRadius = airbrushHaloRadius(brushRadius, scatter);
      const radiusSq = haloRadius * haloRadius;
      const color = this.textureAirbrushColor();
      const alpha = options.strength ?? this.textureAirbrushStrength?.() ?? 0.26;
      const { canvas, context, texture } = editable;
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const useLayerPixels = editable.layerMode === true;
      const eraseLayer = useLayerPixels && options.erase === true;
      const writtenPixels = new Set();
      const referenceUv = Object.prototype.hasOwnProperty.call(options, "referenceUv")
        ? options.referenceUv
        : hit?.uv || target.originUv || target.uvCenter || null;
      const referenceMapped = referenceUv
        ? this.clonePaintTextureUv(referenceUv, texture)
        : null;
      const targetMaterialIndex = hit?.face?.materialIndex
        ?? target.originMaterialIndex
        ?? target.materialIndex
        ?? 0;
      const allowedRegionTriangles = this.texturePaintVisibleRegionTriangles?.(
        record,
        targetMaterialIndex,
        canvas,
        texture,
        { referenceUv }
      ) || [];
      const textureKernelRadius = Math.max(
        2,
        Math.min(
          4,
          Math.round(this.textureBrushRadiusValue() * Math.max(canvas.width, canvas.height) * 0.018)
        )
      );
      const artifactScreenRadius = brushRadius * 2.85;
      const artifactRadiusSq = artifactScreenRadius * artifactScreenRadius;
      let changed = 0;

      const paintTexturePoint = (texturePoint, paintOptions = {}) => {
        if (!texturePoint) {
          return;
        }
        for (let dy = -textureKernelRadius; dy <= textureKernelRadius; dy += 1) {
          for (let dx = -textureKernelRadius; dx <= textureKernelRadius; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > textureKernelRadius) {
              continue;
            }
            const candidate = {
              x: texturePoint.x + dx,
              y: texturePoint.y + dy
            };
            if (
              allowedRegionTriangles.length
              && !this.clonePaintPointInsideTextureTriangles?.(candidate, allowedRegionTriangles, 0.025)
            ) {
              continue;
            }
            const actualPixel = this.clonePaintActualPixelFromTexturePoint?.(candidate, canvas, texture);
            if (!actualPixel) {
              continue;
            }
            const key = `${actualPixel.x}:${actualPixel.y}`;
            if (writtenPixels.has(key) && !paintOptions.allowRepaint) {
              continue;
            }
            const falloff = 1 - distance / Math.max(1, textureKernelRadius);
            const softFalloff = Math.pow(Math.max(0, falloff), 1.85);
            const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
            if (paintOptions.brightOnly && !isBrightArtifactPixel(image.data, offset)) {
              continue;
            }
            writtenPixels.add(key);
            const baseAlpha = paintOptions.forceAlpha
              ?? Math.min(0.42, alpha * (0.06 + softFalloff * 0.72));
            const pixelAlpha = paintOptions.forceAlpha
              ?? artifactTintAlpha(image.data, offset, baseAlpha, softFalloff);
            if (pixelAlpha <= 0.012) {
              continue;
            }
            if (useLayerPixels) {
              if (!this.texturePaintApplyLayerPixel?.(image, offset, color, pixelAlpha, { erase: eraseLayer })) {
                continue;
              }
            } else {
              const nextR = clampByte(image.data[offset] * (1 - pixelAlpha) + color.r * pixelAlpha);
              const nextG = clampByte(image.data[offset + 1] * (1 - pixelAlpha) + color.g * pixelAlpha);
              const nextB = clampByte(image.data[offset + 2] * (1 - pixelAlpha) + color.b * pixelAlpha);
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
            }
            changed += 1;
          }
        }
      };

      const texturePixelForUv = (uvPoint) => {
        const mapped = this.clonePaintTextureUv(uvPoint, texture);
        if (referenceMapped) {
          mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
          mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
        }
        return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, {
          wrap: !referenceMapped
        });
      };

      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (
          !overlay?.visible
          || overlay.userData?.cloneSpotlightKind !== "target"
          || overlay.userData?.cloneSpotlightRecord !== record
        ) {
          continue;
        }
        const geometry = overlay.geometry;
        const position = geometry?.attributes?.position;
        const uv = geometry?.attributes?.uv;
        if (!position || !uv) {
          continue;
        }
        overlay.updateMatrixWorld(true);
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const start = triangle * 3;
          const screenPoints = [];
          const uvPoints = [];
          let clipped = false;
          for (let offset = 0; offset < 3; offset += 1) {
            const vertexIndex = start + offset;
            const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
            this.applyBoneTransform?.(overlay, vertexIndex, local);
            overlay.localToWorld(local);
            const projected = local.project(this.camera);
            if (projected.z < -1 || projected.z > 1) {
              clipped = true;
              break;
            }
            screenPoints.push({
              x: (projected.x * 0.5 + 0.5) * rect.width,
              y: (-projected.y * 0.5 + 0.5) * rect.height
            });
            uvPoints.push(new THREE.Vector2(
              uv.getX(vertexIndex),
              uv.getY(vertexIndex)
            ));
          }
          if (clipped) {
            continue;
          }
          const closest = this.texturePaintClosestTrianglePoint?.(pointer, screenPoints);
          if (!closest || closest.distanceSq > radiusSq) {
            continue;
          }
          const triangleMinX = Math.min(...screenPoints.map((point) => point.x));
          const triangleMaxX = Math.max(...screenPoints.map((point) => point.x));
          const triangleMinY = Math.min(...screenPoints.map((point) => point.y));
          const triangleMaxY = Math.max(...screenPoints.map((point) => point.y));
          const minX = Math.max(0, Math.floor(Math.max(pointer.x - brushRadius, triangleMinX)));
          const maxX = Math.min(rect.width - 1, Math.ceil(Math.min(pointer.x + brushRadius, triangleMaxX)));
          const minY = Math.max(0, Math.floor(Math.max(pointer.y - brushRadius, triangleMinY)));
          const maxY = Math.min(rect.height - 1, Math.ceil(Math.min(pointer.y + brushRadius, triangleMaxY)));
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              const dx = x - pointer.x;
              const dy = y - pointer.y;
              if (dx * dx + dy * dy > radiusSq) {
                continue;
              }
              const screenPoint = { x, y };
              const barycentric = this.clonePaintBarycentric(screenPoint, screenPoints);
              if (!this.clonePaintBarycentricInside(barycentric, 0.02)) {
                continue;
              }
              const paintUv = new THREE.Vector2(
                uvPoints[0].x * barycentric.u + uvPoints[1].x * barycentric.v + uvPoints[2].x * barycentric.w,
                uvPoints[0].y * barycentric.u + uvPoints[1].y * barycentric.v + uvPoints[2].y * barycentric.w
              );
              paintTexturePoint(texturePixelForUv(paintUv));
            }
          }

          const artifactMinX = Math.max(0, Math.floor(Math.max(pointer.x - artifactScreenRadius, triangleMinX)));
          const artifactMaxX = Math.min(rect.width - 1, Math.ceil(Math.min(pointer.x + artifactScreenRadius, triangleMaxX)));
          const artifactMinY = Math.max(0, Math.floor(Math.max(pointer.y - artifactScreenRadius, triangleMinY)));
          const artifactMaxY = Math.min(rect.height - 1, Math.ceil(Math.min(pointer.y + artifactScreenRadius, triangleMaxY)));
          for (let y = artifactMinY; y <= artifactMaxY; y += 4) {
            for (let x = artifactMinX; x <= artifactMaxX; x += 4) {
              const dx = x - pointer.x;
              const dy = y - pointer.y;
              if (dx * dx + dy * dy > artifactRadiusSq) {
                continue;
              }
              const screenPoint = { x, y };
              const barycentric = this.clonePaintBarycentric(screenPoint, screenPoints);
              if (!this.clonePaintBarycentricInside(barycentric, 0.015)) {
                continue;
              }
              const paintUv = new THREE.Vector2(
                uvPoints[0].x * barycentric.u + uvPoints[1].x * barycentric.v + uvPoints[2].x * barycentric.w,
                uvPoints[0].y * barycentric.u + uvPoints[1].y * barycentric.v + uvPoints[2].y * barycentric.w
              );
              paintTexturePoint(texturePixelForUv(paintUv), {
                allowRepaint: true,
                brightOnly: true,
                forceAlpha: 0.96
              });
            }
          }

          const texturePoints = uvPoints.map(texturePixelForUv);
          if (texturePoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
            const minTx = Math.floor(Math.min(...texturePoints.map((point) => point.x)));
            const maxTx = Math.ceil(Math.max(...texturePoints.map((point) => point.x)));
            const minTy = Math.floor(Math.min(...texturePoints.map((point) => point.y)));
            const maxTy = Math.ceil(Math.max(...texturePoints.map((point) => point.y)));
            const textureArea = Math.max(0, maxTx - minTx + 1) * Math.max(0, maxTy - minTy + 1);
            const maxTextureSamples = 2200;
            const textureStep = Math.max(2, Math.ceil(Math.sqrt(textureArea / maxTextureSamples)));
            for (let ty = minTy; ty <= maxTy; ty += textureStep) {
              for (let tx = minTx; tx <= maxTx; tx += textureStep) {
                const texturePoint = { x: tx, y: ty };
                const barycentric = this.clonePaintBarycentric(texturePoint, texturePoints);
                if (!this.clonePaintBarycentricInside(barycentric, 0.015)) {
                  continue;
                }
                const sx = (
                  screenPoints[0].x * barycentric.u
                  + screenPoints[1].x * barycentric.v
                  + screenPoints[2].x * barycentric.w
                );
                const sy = (
                  screenPoints[0].y * barycentric.u
                  + screenPoints[1].y * barycentric.v
                  + screenPoints[2].y * barycentric.w
                );
                const dx = sx - pointer.x;
                const dy = sy - pointer.y;
                if (dx * dx + dy * dy > radiusSq) {
                  continue;
                }
                paintTexturePoint(texturePoint);
              }
            }
          }
        }
      }

      if (!changed) {
        return null;
      }
      context.putImageData(image, 0, 0);
      texture.needsUpdate = true;
      material.needsUpdate = true;
      this.texturePaintCommitEditable?.(editable, material, record);
      this.markTexturePaintStrokeChanged?.();
      this.refreshCloneSpotlightTextures?.(record);
      this.updateClonePaintPreviews?.();
      this.setStatus(`${eraseLayer ? "Erased" : "Airbrushed"} ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      return changed;
    }
  });
}
