import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import {
  textureAirbrushFrontIntersections,
  textureAirbrushPointInRect,
  textureAirbrushProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent
} from "./projection.js";

function projectionProbeKey(point = null) {
  return `${Math.round(point?.x || 0)}:${Math.round(point?.y || 0)}`;
}

function projectionPointDistance(left = null, right = null) {
  if (
    !Number.isFinite(left?.x)
    || !Number.isFinite(left?.y)
    || !Number.isFinite(right?.x)
    || !Number.isFinite(right?.y)
  ) {
    return 0;
  }
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function projectionStaticUniformsCurrent(projectionFrame = null, shaderMaterial = null, depthTarget = null, rect = null) {
  const state = projectionFrame?.shaderStaticUniforms;
  return Boolean(
    state
    && state.shaderMaterial === shaderMaterial
    && state.depthTexture === depthTarget?.depthTexture
    && state.width === rect?.width
    && state.height === rect?.height
  );
}

function markProjectionStaticUniformsCurrent(projectionFrame = null, shaderMaterial = null, depthTarget = null, rect = null) {
  if (!projectionFrame) {
    return;
  }
  projectionFrame.shaderStaticUniforms = {
    shaderMaterial,
    depthTexture: depthTarget?.depthTexture || null,
    width: rect?.width || 0,
    height: rect?.height || 0
  };
}

function cachedPassProbePointsFromStroke(stroke = null, options = {}) {
  if (!stroke?.center) {
    return [];
  }
  const radiusPixels = Math.max(1, Number(options.radiusPixels) || 1);
  const cachedPassCount = Math.max(0, Math.floor(Number(options.cachedPassCount) || 0));
  const probes = [];
  const seen = new Set();
  const addProbe = (point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      return;
    }
    const key = projectionProbeKey(point);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    probes.push({ x: point.x, y: point.y });
  };
  if (cachedPassCount <= 1) {
    addProbe(stroke.center);
    addProbe(stroke.start);
    return probes;
  }

  const centers = [];
  const centerKeys = new Set();
  const maxCenters = radiusPixels <= 16
    ? 18
    : 12;
  const addCenter = (point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || centers.length >= maxCenters) {
      return;
    }
    const key = projectionProbeKey(point);
    if (centerKeys.has(key)) {
      return;
    }
    centerKeys.add(key);
    centers.push({ x: point.x, y: point.y });
  };
  addCenter(stroke.center);
  addCenter(stroke.start);
  for (const segment of (stroke.strokeSegments || [])) {
    addCenter(segment.start);
    const distance = projectionPointDistance(segment.start, segment.end);
    const step = Math.max(18, Math.min(56, radiusPixels * 3));
    const sampleCount = Math.min(6, Math.floor(distance / step));
    for (let index = 1; index <= sampleCount; index += 1) {
      const ratio = index / (sampleCount + 1);
      addCenter({
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio
      });
    }
    addCenter(segment.end);
  }
  const offset = radiusPixels > 8
    ? Math.min(36, Math.max(6, radiusPixels * 0.75))
    : 0;
  for (const center of centers) {
    addProbe(center);
    if (!offset) {
      continue;
    }
    addProbe({ x: center.x - offset, y: center.y });
    addProbe({ x: center.x + offset, y: center.y });
    addProbe({ x: center.x, y: center.y - offset });
    addProbe({ x: center.x, y: center.y + offset });
  }
  return probes;
}

function materialsForProjectionRecord(record = null) {
  return Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
}

function projectionPaintPassKey(recordIndices = null, paintRecords = [], record = null, materialIndex = 0, material = null) {
  const recordIndex = recordIndices?.get(record) ?? paintRecords.indexOf(record);
  return [
    recordIndex,
    materialIndex,
    material?.uuid || material?.id || "material"
  ].join(":");
}

export function installTextureAirbrushWebGlProjectMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushGpuProjectionFrame() {
      if (!this.canvas || !this.camera || !this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return null;
      }
      this.model.updateMatrixWorld?.(true);
      this.refreshSkinnedRaycastBounds?.();
      const paintObjects = paintRecords.map((record) => record.object);
      const frame = {
        canvas: this.canvas,
        camera: this.camera,
        model: this.model,
        rect,
        paintRecords,
        paintObjects,
        recordByObject: new Map(paintRecords.map((record) => [record.object, record])),
        recordIndices: new Map(paintRecords.map((record, index) => [record, index])),
        paintPassCache: new Map(),
        probePaintPassCache: new Map(),
        proxySceneCache: new Map()
      };
      this.textureAirbrushSeedProjectionFramePaintPasses?.(frame);
      return frame;
    },

    textureAirbrushSeedProjectionFramePaintPasses(projectionFrame = null) {
      if (!projectionFrame?.paintPassCache || !Array.isArray(projectionFrame.paintRecords)) {
        return 0;
      }
      if (projectionFrame.paintPassCacheSeeded === true) {
        return 0;
      }
      projectionFrame.paintPassCacheSeeded = true;
      let seeded = 0;
      for (const record of projectionFrame.paintRecords) {
        if (!record?.geometry?.attributes?.uv) {
          continue;
        }
        const materials = materialsForProjectionRecord(record);
        for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
          const material = materials[materialIndex];
          const targetEntry = material?.userData?.textureAirbrushGpuTarget;
          if (!material || !targetEntry?.target?.texture) {
            continue;
          }
          const key = projectionPaintPassKey(
            projectionFrame.recordIndices,
            projectionFrame.paintRecords,
            record,
            materialIndex,
            material
          );
          if (projectionFrame.paintPassCache.has(key)) {
            continue;
          }
          projectionFrame.paintPassCache.set(key, {
            key,
            record,
            materialIndex,
            material,
            targetEntry,
            undoCaptured: false
          });
          seeded += 1;
        }
      }
      return seeded;
    },

    textureAirbrushResetLiveProjectionFrame() {
      this.textureAirbrushLiveProjectionFrameState = null;
    },

    textureAirbrushLiveProjectionFrame() {
      if (!this.canvas || !this.camera || !this.model) {
        this.textureAirbrushLiveProjectionFrameState = null;
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const existing = this.textureAirbrushLiveProjectionFrameState;
      if (
        existing?.canvas === this.canvas
        && existing.camera === this.camera
        && existing.model === this.model
        && existing.rect?.width === rect.width
        && existing.rect?.height === rect.height
        && existing.rect?.left === rect.left
        && existing.rect?.top === rect.top
      ) {
        return existing;
      }
      const frame = this.textureAirbrushGpuProjectionFrame();
      this.textureAirbrushLiveProjectionFrameState = frame;
      return frame;
    },

    textureAirbrushGpuProjectFromEvent(event, options = {}) {
      if (!this.renderer || !event || !this.canvas || !this.camera || !this.model) {
        return 0;
      }
      const projectionFrame = options.projectionFrame?.canvas === this.canvas
        && options.projectionFrame?.camera === this.camera
        && options.projectionFrame?.model === this.model
        ? options.projectionFrame
        : null;
      const rect = projectionFrame?.rect || this.canvas.getBoundingClientRect();
      const paintRecords = projectionFrame?.paintRecords || (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      if (!paintRecords.length) {
        return 0;
      }
      if (!projectionFrame) {
        this.model.updateMatrixWorld?.(true);
        this.refreshSkinnedRaycastBounds?.();
      }
      const paintObjects = projectionFrame?.paintObjects || paintRecords.map((record) => record.object);
      const recordByObject = projectionFrame?.recordByObject || new Map(paintRecords.map((record) => [record.object, record]));
      const recordIndices = projectionFrame?.recordIndices || null;
      const probePaintPassCache = projectionFrame?.probePaintPassCache || null;
      this.textureAirbrushSeedProjectionFramePaintPasses?.(projectionFrame);
      const stroke = textureAirbrushScreenStrokeFromEvent(event, rect, options);
      if (!stroke) {
        return 0;
      }
      const screenCenter = stroke.center;
      const screenStart = stroke.start;
      const screenSegments = stroke.strokeSegments;
      const brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      let depthTarget = projectionFrame?.depthTarget || null;
      if (!depthTarget) {
        depthTarget = this.textureAirbrushRenderDepthTarget({ reuse: true });
        if (projectionFrame) {
          projectionFrame.depthTarget = depthTarget;
        }
      }
      if (!depthTarget) {
        return 0;
      }

      const paintPasses = new Map();
      const ensurePaintPassUndoCaptured = (pass) => {
        if (!pass || pass.undoCaptured === true) {
          return;
        }
        pass.undoCaptured = this.captureTexturePaintGpuUndoTarget?.(
          pass.record,
          pass.material,
          pass.targetEntry,
          pass.materialIndex
        ) !== false;
      };
      const addPaintPass = (record, materialIndex, material) => {
        if (!record?.geometry?.attributes?.uv || !material) {
          return;
        }
        const key = projectionPaintPassKey(recordIndices, paintRecords, record, materialIndex, material);
        const cachedPass = projectionFrame?.paintPassCache?.get(key);
        if (cachedPass) {
          ensurePaintPassUndoCaptured(cachedPass);
          if (!paintPasses.has(key)) {
            paintPasses.set(key, cachedPass);
          }
          return cachedPass;
        }
        if (paintPasses.has(key)) {
          return paintPasses.get(key);
        }
        const targetEntry = this.textureAirbrushGpuTargetForMaterial(material);
        if (!targetEntry) {
          return null;
        }
        const undoCaptured = this.captureTexturePaintGpuUndoTarget?.(record, material, targetEntry, materialIndex) !== false;
        const pass = { key, record, materialIndex, material, targetEntry };
        pass.undoCaptured = undoCaptured;
        paintPasses.set(key, pass);
        projectionFrame?.paintPassCache?.set(key, pass);
        return pass;
      };
      const cachedPassCount = projectionFrame?.paintPassCache?.size || 0;
      const spacingPercent = Number(options.spacing);
      const shouldRenderCachedContinuousPasses = Number.isFinite(spacingPercent)
        && spacingPercent <= 10
        && cachedPassCount
        && options.reusePaintPasses !== false;
      if (shouldRenderCachedContinuousPasses) {
        for (const pass of projectionFrame.paintPassCache.values()) {
          paintPasses.set(pass.key, pass);
        }
      }
      const probes = paintPasses.size
        ? []
        : cachedPassCount && options.reusePaintPasses !== false
        ? cachedPassProbePointsFromStroke(stroke, { radiusPixels: brushRadius, cachedPassCount })
        : textureAirbrushProbePointsFromStroke(stroke, brushRadius);
      const visitedProbeKeys = new Set();
      const projectProbePoints = (candidateProbes = []) => {
        for (const probe of candidateProbes) {
          if (cachedPassCount && paintPasses.size >= cachedPassCount) {
            break;
          }
          if (!textureAirbrushPointInRect(probe, rect)) {
            continue;
          }
          const probeKey = projectionProbeKey(probe);
          if (visitedProbeKeys.has(probeKey)) {
            continue;
          }
          visitedProbeKeys.add(probeKey);
          if (probePaintPassCache?.has(probeKey)) {
            for (const pass of probePaintPassCache.get(probeKey) || []) {
              paintPasses.set(pass.key, pass);
            }
            continue;
          }
          const probePasses = [];
          const probePassKeys = new Set();
          this.pointer.x = (probe.x / rect.width) * 2 - 1;
          this.pointer.y = -(probe.y / rect.height) * 2 + 1;
          this.raycaster.setFromCamera(this.pointer, this.camera);
          const intersections = this.raycaster.intersectObjects(paintObjects, false);
          for (const hit of textureAirbrushFrontIntersections(intersections)) {
            const record = recordByObject.get(hit.object);
            const materialIndex = hit.face?.materialIndex ?? 0;
            const material = record ? this.clonePaintMaterialForHit?.(record, hit) : null;
            const pass = addPaintPass(record, materialIndex, material);
            if (pass && !probePassKeys.has(pass.key)) {
              probePassKeys.add(pass.key);
              probePasses.push(pass);
            }
          }
          probePaintPassCache?.set(probeKey, probePasses);
          if (cachedPassCount && paintPasses.size >= cachedPassCount) {
            break;
          }
        }
      };
      if (probes.length) {
        projectProbePoints(probes);
      }
      const shouldSupplementCachedProbes = cachedPassCount
        && options.reusePaintPasses !== false
        && !paintPasses.size;
      if (shouldSupplementCachedProbes) {
        projectProbePoints(textureAirbrushProbePointsFromStroke(stroke, brushRadius));
      }
      if (!paintPasses.size) {
        return 0;
      }

      const shaderMaterial = this.textureAirbrushBrushShaderMaterial();
      if (!projectionStaticUniformsCurrent(projectionFrame, shaderMaterial, depthTarget, rect)) {
        shaderMaterial.uniforms.paintViewMatrix.value.copy(this.camera.matrixWorldInverse);
        shaderMaterial.uniforms.paintProjectionMatrix.value.copy(this.camera.projectionMatrix);
        shaderMaterial.uniforms.depthTexture.value = depthTarget.depthTexture;
        shaderMaterial.uniforms.viewportSize.value.set(rect.width, rect.height);
        markProjectionStaticUniformsCurrent(projectionFrame, shaderMaterial, depthTarget, rect);
      }
      shaderMaterial.uniforms.brushCenter.value.set(screenCenter.x, screenCenter.y);
      shaderMaterial.uniforms.brushStart.value.set(screenStart.x, screenStart.y);
      const strokeSegmentCount = Math.min(screenSegments.length, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS);
      shaderMaterial.uniforms.strokeSegmentCount.value = strokeSegmentCount;
      for (let index = 0; index < strokeSegmentCount; index += 1) {
        const segment = screenSegments[index];
        shaderMaterial.uniforms.strokeStarts.value[index].set(segment.start.x, segment.start.y);
        shaderMaterial.uniforms.strokeEnds.value[index].set(segment.end.x, segment.end.y);
      }
      const color = this.textureAirbrushShaderColor(options.color || null);
      shaderMaterial.uniforms.paintColor.value.setRGB(color.r, color.g, color.b);
      shaderMaterial.uniforms.radiusPixels.value = brushRadius;
      shaderMaterial.uniforms.strength.value = options.strength ?? 1;
      shaderMaterial.uniforms.brushOpacity.value = options.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42;
      shaderMaterial.uniforms.brushHardness.value = options.hardness ?? this.textureAirbrushHardness?.() ?? 0.35;
      shaderMaterial.uniforms.scatterAmount.value = options.scatter ?? this.textureAirbrushScatter?.() ?? 0.35;
      shaderMaterial.uniforms.depthEpsilon.value = options.depthEpsilon
        ?? Math.max(0.01, Math.min(0.035, this.textureBrushRadiusValue() * 0.55));
      shaderMaterial.needsUpdate = false;

      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      for (const pass of paintPasses.values()) {
        ensurePaintPassUndoCaptured(pass);
        let proxyEntry = projectionFrame?.proxySceneCache?.get(pass.key);
        if (!proxyEntry) {
          proxyEntry = this.textureAirbrushGpuProxyForRecord(pass.record, pass.materialIndex, pass.material);
          proxyEntry?.proxy?.skeleton?.update?.();
          projectionFrame?.proxySceneCache?.set(pass.key, proxyEntry);
        }
        const { scene } = proxyEntry || {};
        if (!scene) {
          continue;
        }
        this.renderer.setRenderTarget(pass.targetEntry.target);
        const bleedOffsets = this.textureAirbrushGpuUvBleedOffsets?.(pass.targetEntry, brushRadius) || [new THREE.Vector2()];
        for (const offset of bleedOffsets) {
          shaderMaterial.uniforms.uvOffset.value.copy(offset);
          this.renderer.render(scene, this.textureAirbrushGpuCopyCamera);
        }
        if (pass.targetEntry?.target?.texture && pass.material.map !== pass.targetEntry.target.texture) {
          pass.material.map = pass.targetEntry.target.texture;
          pass.material.needsUpdate = true;
        }
      }
      shaderMaterial.uniforms.uvOffset.value.set(0, 0);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;

      const segmentLength = screenSegments.reduce((total, segment) => {
        const dx = segment.end.x - segment.start.x;
        const dy = segment.end.y - segment.start.y;
        return total + Math.sqrt(dx * dx + dy * dy);
      }, 0);
      const radiusPixels = shaderMaterial.uniforms.radiusPixels.value;
      const estimate = Math.max(
        1,
        Math.round((Math.PI * radiusPixels * radiusPixels + segmentLength * radiusPixels * 2) * paintPasses.size)
      );
      this.markTexturePaintStrokeChanged?.();
      this.setStatus(`Airbrushed ${estimate} projected pixels`);
      return estimate;
    }
  });
}
