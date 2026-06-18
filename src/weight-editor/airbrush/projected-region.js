import {
  clampByte,
  isBrightArtifactPixel
} from "./math.js";
import { textureAirbrushPointInRect } from "./projection.js";

export function installTextureAirbrushProjectedRegionMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushProjectedRegionFromEvent(record, event, hit, options = {}) {
      const target = record ? this.clonePaintTargets?.get(record) : null;
      if (!record || !target?.vertices?.size || !event || !this.canvas || !this.camera) {
        return 0;
      }
      const changed = this.textureAirbrushBrightMeshUnderRegionPointer?.(event, options) || 0;
      if (changed > 0) {
        this.setStatus(`Airbrushed ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
        return changed;
      }
      this.setStatus("Airbrush needs a visible Region surface");
      return 0;
    },

    textureAirbrushBrightMeshUnderRegionPointer(event, options = {}) {
      if (!event || !this.canvas || !this.camera) {
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const targetEntries = [...(this.clonePaintTargets?.entries?.() || [])]
        .filter(([record, target]) => record?.object && target?.vertices?.size);
      if (!targetEntries.length) {
        return 0;
      }
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = targetEntries.map(([record]) => record.object);
      const targetByRecord = new Map(targetEntries);
      const recordByObject = new Map(targetEntries.map(([record]) => [record.object, record]));
      const color = this.textureAirbrushColor();
      const screenCenter = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = this.textureBrushRadiusScreenPixels?.() || 24;
      const screenRadius = Math.max(brushRadius * 1.65, 12);
      const screenRadiusSq = screenRadius * screenRadius;
      const step = Math.max(4, Math.min(9, brushRadius * 0.48));
      const samples = [{ x: screenCenter.x, y: screenCenter.y, distanceSq: 0 }];
      for (let dy = -screenRadius; dy <= screenRadius; dy += step) {
        for (let dx = -screenRadius; dx <= screenRadius; dx += step) {
          if (!dx && !dy) {
            continue;
          }
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > screenRadiusSq) {
            continue;
          }
          samples.push({
            x: screenCenter.x + dx,
            y: screenCenter.y + dy,
            distanceSq
          });
        }
      }
      samples.sort((left, right) => left.distanceSq - right.distanceSq);

      const states = new Map();
      const stateForHit = (record, target, hit) => {
        const material = this.clonePaintMaterialForHit?.(record, hit);
        const editable = this.editableClonePaintTexture?.(material);
        if (!material || !editable) {
          return null;
        }
        const { canvas, context, texture } = editable;
        const materialIndex = hit?.face?.materialIndex
          ?? target.originMaterialIndex
          ?? target.materialIndex
          ?? 0;
        const referenceUv = target.originUv || target.uvCenter || hit.uv || null;
        const key = [
          this.paintRecords.indexOf(record),
          materialIndex,
          material.uuid || material.id || "material"
        ].join(":");
        const existing = states.get(key);
        if (existing) {
          return existing;
        }
        const regionTriangles = this.clonePaintRegionTextureTriangles?.(
          record,
          target,
          materialIndex,
          canvas,
          texture,
          { referenceUv }
        ) || [];
        if (!regionTriangles.length) {
          return null;
        }
        this.captureTexturePaintCanvasUndoTarget?.(record, material, editable, materialIndex);
        const state = {
          record,
          target,
          material,
          materialIndex,
          canvas,
          context,
          texture,
          image: context.getImageData(0, 0, canvas.width, canvas.height),
          referenceUv,
          regionTriangles,
          written: new Set(),
          changed: 0
        };
        states.set(key, state);
        return state;
      };

      let changed = 0;
      let paintedHits = 0;

      const paintHit = (hit, sample) => {
        const record = recordByObject.get(hit.object);
        const target = record ? targetByRecord.get(record) : null;
        if (!record || !target?.vertices?.size || !hit?.uv) {
          return 0;
        }
        if (!this.clonePaintHitInsideRegion?.(hit, target)) {
          return 0;
        }
        const state = stateForHit(record, target, hit);
        if (!state) {
          return 0;
        }
        const center = this.textureAirbrushRegionPixelFromUv(
          hit.uv,
          state.canvas,
          state.texture,
          state.referenceUv
        );
        if (!center) {
          return 0;
        }
        const radiusPixels = Math.max(
          3,
          Math.min(
            12,
            Math.round(this.textureBrushRadiusValue() * Math.max(state.canvas.width, state.canvas.height) * 0.024)
          )
        );
        let localChanged = 0;
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > radiusPixels) {
              continue;
            }
            const texturePoint = {
              x: center.x + dx,
              y: center.y + dy
            };
            if (!this.clonePaintPointInsideTextureTriangles?.(texturePoint, state.regionTriangles, 0.045)) {
              continue;
            }
            const actualPixel = this.clonePaintActualPixelFromTexturePoint?.({
              x: center.x + dx,
              y: center.y + dy
            }, state.canvas, state.texture);
            if (!actualPixel) {
              continue;
            }
            const key = `${actualPixel.x}:${actualPixel.y}`;
            if (state.written.has(key)) {
              continue;
            }
            state.written.add(key);
            const offset = (actualPixel.y * state.canvas.width + actualPixel.x) * 4;
            const brightArtifact = isBrightArtifactPixel(state.image.data, offset);
            const falloff = 1 - distance / Math.max(1, radiusPixels);
            const screenFalloff = 1 - Math.sqrt(sample.distanceSq) / Math.max(1, screenRadius);
            const alpha = brightArtifact
              ? Math.min(
                0.98,
                0.36
                  + Math.pow(Math.max(0, falloff), 1.45) * 0.48
                  + Math.pow(Math.max(0, screenFalloff), 1.2) * 0.16
              )
              : Math.min(
                0.36,
                0.045
                  + Math.pow(Math.max(0, falloff), 1.7) * 0.23
                  + Math.pow(Math.max(0, screenFalloff), 1.35) * 0.085
              );
            const nextR = clampByte(state.image.data[offset] * (1 - alpha) + color.r * alpha);
            const nextG = clampByte(state.image.data[offset + 1] * (1 - alpha) + color.g * alpha);
            const nextB = clampByte(state.image.data[offset + 2] * (1 - alpha) + color.b * alpha);
            const nextA = Math.max(state.image.data[offset + 3], 255);
            if (
              state.image.data[offset] === nextR
              && state.image.data[offset + 1] === nextG
              && state.image.data[offset + 2] === nextB
              && state.image.data[offset + 3] === nextA
            ) {
              continue;
            }
            state.image.data[offset] = nextR;
            state.image.data[offset + 1] = nextG;
            state.image.data[offset + 2] = nextB;
            state.image.data[offset + 3] = nextA;
            localChanged += 1;
          }
        }
        if (localChanged) {
          state.changed += localChanged;
          changed += localChanged;
        }
        return localChanged;
      };

      for (const sample of samples.slice(0, 72)) {
        if (!textureAirbrushPointInRect(sample, rect)) {
          continue;
        }
        this.pointer.x = (sample.x / rect.width) * 2 - 1;
        this.pointer.y = -(sample.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        const hitChanged = intersections[0] ? paintHit(intersections[0], sample) : 0;
        if (hitChanged > 0) {
          paintedHits += 1;
        }
        if (paintedHits >= 72) {
          break;
        }
      }

      for (const state of states.values()) {
        if (!state.changed) {
          continue;
        }
        state.context.putImageData(state.image, 0, 0);
        state.texture.needsUpdate = true;
        state.material.needsUpdate = true;
        this.refreshCloneSpotlightTextures?.(state.record);
      }
      if (changed) {
        this.markTexturePaintStrokeChanged?.();
        this.updateClonePaintPreviews?.();
      }
      return changed;
    }
  });
}
