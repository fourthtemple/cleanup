import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import {
  textureAirbrushFrontIntersections,
  textureAirbrushPointInRect,
  textureAirbrushProbePointsFromStroke,
  textureAirbrushScreenStrokeFromEvent
} from "./projection.js";

const TEXTURE_AIRBRUSH_NEIGHBOR_MASK_ATTRIBUTE = "textureAirbrushNeighborMask";
const TEXTURE_AIRBRUSH_NEIGHBOR_VIEW_NORMAL_THRESHOLD = 0.18;

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

function normalizedProjectionNormal(normal = null) {
  const x = Number(normal?.x);
  const y = Number(normal?.y);
  const z = Number(normal?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  const length = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return {
    x: x / length,
    y: y / length,
    z: z / length
  };
}

function projectionLayerEffectivelyEmpty(layer = null) {
  if (!layer) {
    return true;
  }
  if (Math.max(0, Math.floor(Number(layer.gpuTarget?.paintRevision) || 0)) > 0) {
    return false;
  }
  if (layer.isEmpty === true && layer.gpuTarget?.emptyTransparent !== false) {
    return true;
  }
  return layer.gpuTarget?.emptyTransparent === true && layer.isEmpty !== false;
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

function projectionFramePointFromEvent(projectionFrame = null, event = null) {
  const rect = projectionFrame?.rect || null;
  if (!rect || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
    return null;
  }
  return {
    x: event.clientX - (rect.left || 0),
    y: event.clientY - (rect.top || 0)
  };
}

function activeLayerGpuTargetForProjection(editor = null, material = null) {
  if (
    !editor
    || !material
    || editor.activeTool !== "airbrush"
    || editor.texturePaintLayerModeActive?.() !== true
  ) {
    return null;
  }
  const stack = material.userData?.texturePaintLayerStack || null;
  const active = editor.texturePaintEnsureActiveLayerForStack?.(stack)
    || (
      editor.texturePaintBackgroundSelectionActive === true
        ? null
        : editor.texturePaintActivePaintLayerForStack?.(stack, { fallback: false })
    )
    || null;
  const activeLayer = active?.layer
    || stack?.layers?.find((layer) => layer?.id && layer.id === stack.activeLayerId)
    || null;
  const targetEntry = activeLayer?.gpuTarget || null;
  if (!targetEntry?.target?.texture) {
    return null;
  }
  targetEntry.material = material;
  targetEntry.layer ||= activeLayer;
  targetEntry.layerStack ||= stack;
  targetEntry.layerMode = true;
  targetEntry.emptyTransparent = projectionLayerEffectivelyEmpty(activeLayer);
  return targetEntry;
}

function projectionSeedTargetEntryForMaterial(editor = null, material = null) {
  if (editor?.activeTool === "airbrush" && editor.texturePaintLayerModeActive?.() === true) {
    return activeLayerGpuTargetForProjection(editor, material);
  }
  return material?.userData?.textureAirbrushGpuTarget || null;
}

function shouldSeedProjectionProxyForPaintPass(editor = null, targetEntry = null, material = null) {
  return Boolean(
    editor
    && targetEntry?.layerMode === true
    && targetEntry?.target?.texture
    && material
    && editor.activeTool === "airbrush"
    && editor.texturePaintLayerModeActive?.() === true
  );
}

export function installTextureAirbrushWebGlProjectMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushNeighborGpuMaskAttribute(seed = null, record = null) {
      if (
        !seed?.enabled
        || !seed.component?.size
        || !record?.geometry?.attributes?.position
        || this.textureAirbrushNeighborRecordMatches?.(seed, record) === false
      ) {
        return null;
      }
      const geometry = record.geometry;
      const vertexCount = Math.max(0, Math.floor(Number(geometry.attributes.position.count) || 0));
      if (!vertexCount || typeof THREE.BufferAttribute !== "function") {
        return null;
      }
      geometry.userData ||= {};
      const cacheKey = [
        seed.key || this.textureAirbrushNeighborSeedKey?.(seed) || "neighbor",
        geometry.uuid || geometry.id || "geometry",
        vertexCount
      ].join(":");
      const cached = geometry.userData.textureAirbrushNeighborMask;
      if (
        cached?.key === cacheKey
        && cached.attribute
        && geometry.attributes?.[TEXTURE_AIRBRUSH_NEIGHBOR_MASK_ATTRIBUTE] === cached.attribute
      ) {
        return cached.attribute;
      }

      const values = cached?.attribute?.array?.length === vertexCount
        ? cached.attribute.array
        : new Float32Array(vertexCount);
      values.fill(0);
      for (const vertexIndex of seed.component) {
        if (Number.isInteger(vertexIndex) && vertexIndex >= 0 && vertexIndex < vertexCount) {
          values[vertexIndex] = 1;
        }
        for (const linkedIndex of this.textureAirbrushNeighborLinkedVertices?.(record, vertexIndex) || []) {
          if (Number.isInteger(linkedIndex) && linkedIndex >= 0 && linkedIndex < vertexCount) {
            values[linkedIndex] = 1;
          }
        }
      }

      const attribute = cached?.attribute?.array === values
        ? cached.attribute
        : new THREE.BufferAttribute(values, 1);
      attribute.needsUpdate = true;
      geometry.setAttribute?.(TEXTURE_AIRBRUSH_NEIGHBOR_MASK_ATTRIBUTE, attribute);
      geometry.userData.textureAirbrushNeighborMask = { key: cacheKey, attribute };
      return attribute;
    },

    textureAirbrushGpuProjectionFrame(options = {}) {
      if (!this.canvas || !this.camera || !this.model) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const frameKey = typeof this.textureAirbrushDepthCacheKey === "function"
        ? this.textureAirbrushDepthCacheKey(rect)
        : "";
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
        frameKey,
        layerMutationSerial: this.texturePaintLayerModeActive?.() === true
          ? this.texturePaintLayerMutationSerialValue?.() ?? 0
          : null,
        paintRecords,
        paintObjects,
        recordByObject: new Map(paintRecords.map((record) => [record.object, record])),
        recordIndices: new Map(paintRecords.map((record, index) => [record, index])),
        seedPaintPasses: options.seedPaintPasses !== false,
        seedLayerProxies: options.seedLayerProxies !== false,
        paintPassCache: new Map(),
        probePaintPassCache: new Map(),
        proxySceneCache: new Map()
      };
      if (frame.seedPaintPasses !== false) {
        this.textureAirbrushSeedProjectionFramePaintPasses?.(frame);
      }
      return frame;
    },

    textureAirbrushSeedProjectionFramePaintPasses(projectionFrame = null) {
      if (!projectionFrame?.paintPassCache || !Array.isArray(projectionFrame.paintRecords)) {
        return 0;
      }
      if (projectionFrame.seedPaintPasses === false) {
        return 0;
      }
      if (projectionFrame.paintPassCacheSeeded === true) {
        if (projectionFrame.seedLayerProxies !== false) {
          this.textureAirbrushSeedProjectionFrameLayerProxies?.(projectionFrame);
        }
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
          const targetEntry = projectionSeedTargetEntryForMaterial(this, material);
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
      if (projectionFrame.seedLayerProxies !== false) {
        this.textureAirbrushSeedProjectionFrameLayerProxies?.(projectionFrame);
      }
      return seeded;
    },

    textureAirbrushSeedProjectionFramePaintPass(projectionFrame = null, record = null, materialIndex = 0, material = null, options = {}) {
      if (!projectionFrame?.paintPassCache || !record?.geometry?.attributes?.uv || !material) {
        return null;
      }
      if (Array.isArray(projectionFrame.paintRecords) && !projectionFrame.paintRecords.includes(record)) {
        return null;
      }
      const targetEntry = projectionSeedTargetEntryForMaterial(this, material);
      if (!targetEntry?.target?.texture) {
        return null;
      }
      const key = projectionPaintPassKey(
        projectionFrame.recordIndices,
        projectionFrame.paintRecords,
        record,
        materialIndex,
        material
      );
      let pass = projectionFrame.paintPassCache.get(key);
      if (!pass) {
        pass = {
          key,
          record,
          materialIndex,
          material,
          targetEntry,
          undoCaptured: false
        };
        projectionFrame.paintPassCache.set(key, pass);
      }
      if (options.seedProbe !== false && projectionFrame.probePaintPassCache) {
        const point = projectionFramePointFromEvent(projectionFrame, options.event || null);
        if (point && textureAirbrushPointInRect(point, projectionFrame.rect)) {
          const probeKey = projectionProbeKey(point);
          const probePasses = projectionFrame.probePaintPassCache.get(probeKey) || [];
          if (!probePasses.some((probePass) => probePass?.key === pass.key)) {
            projectionFrame.probePaintPassCache.set(probeKey, [...probePasses, pass]);
          }
        }
      }
      if (
        options.seedLayerProxy !== false
        && projectionFrame.proxySceneCache
        && !projectionFrame.proxySceneCache.has(key)
        && shouldSeedProjectionProxyForPaintPass(this, targetEntry, material)
      ) {
        const proxyEntry = this.textureAirbrushGpuProxyForRecord?.(record, materialIndex, material);
        proxyEntry?.proxy?.skeleton?.update?.();
        if (proxyEntry) {
          projectionFrame.proxySceneCache.set(key, proxyEntry);
        }
      }
      return pass;
    },

    textureAirbrushSeedProjectionFrameLayerProxies(projectionFrame = null) {
      if (!projectionFrame?.proxySceneCache || !projectionFrame?.paintPassCache) {
        return 0;
      }
      if (projectionFrame.layerProjectionProxiesSeeded === true) {
        return 0;
      }
      projectionFrame.layerProjectionProxiesSeeded = true;
      let seeded = 0;
      for (const pass of projectionFrame.paintPassCache.values()) {
        if (
          !pass
          || projectionFrame.proxySceneCache.has(pass.key)
          || !shouldSeedProjectionProxyForPaintPass(this, pass.targetEntry, pass.material)
        ) {
          continue;
        }
        const proxyEntry = this.textureAirbrushGpuProxyForRecord?.(pass.record, pass.materialIndex, pass.material);
        proxyEntry?.proxy?.skeleton?.update?.();
        if (proxyEntry) {
          projectionFrame.proxySceneCache.set(pass.key, proxyEntry);
          seeded += 1;
        }
      }
      return seeded;
    },

    textureAirbrushLiveProjectionFrameCurrent(projectionFrame = null) {
      if (!projectionFrame || !this.canvas || !this.camera || !this.model) {
        return false;
      }
      const rect = this.canvas.getBoundingClientRect();
      if (
        projectionFrame.canvas !== this.canvas
        || projectionFrame.camera !== this.camera
        || projectionFrame.model !== this.model
        || projectionFrame.rect?.width !== rect.width
        || projectionFrame.rect?.height !== rect.height
        || projectionFrame.rect?.left !== rect.left
        || projectionFrame.rect?.top !== rect.top
      ) {
        return false;
      }
      if (
        this.texturePaintLayerModeActive?.() === true
        && projectionFrame.layerMutationSerial !== (this.texturePaintLayerMutationSerialValue?.() ?? 0)
      ) {
        return false;
      }
      if (typeof this.textureAirbrushDepthCacheKey !== "function") {
        return true;
      }
      const frameKey = this.textureAirbrushDepthCacheKey(rect);
      if (!frameKey) {
        return !this.renderer && projectionFrame.frameKey === "";
      }
      return projectionFrame.frameKey === frameKey;
    },

    textureAirbrushResetLiveProjectionFrame(options = {}) {
      if (
        options.keepCurrent === true
        && this.textureAirbrushLiveProjectionFrameCurrent?.(this.textureAirbrushLiveProjectionFrameState)
      ) {
        return false;
      }
      this.textureAirbrushLiveProjectionFrameState = null;
      this.textureAirbrushClearLayerHitSeed?.();
      return true;
    },

    textureAirbrushLiveProjectionFrame(options = {}) {
      if (!this.canvas || !this.camera || !this.model) {
        this.textureAirbrushLiveProjectionFrameState = null;
        return null;
      }
      const existing = this.textureAirbrushLiveProjectionFrameState;
      if (this.textureAirbrushLiveProjectionFrameCurrent?.(existing)) {
        if (options.seedPaintPasses !== false && existing.seedPaintPasses === false) {
          existing.seedPaintPasses = true;
          this.textureAirbrushSeedProjectionFramePaintPasses?.(existing);
        }
        if (options.seedLayerProxies !== false) {
          existing.seedLayerProxies = true;
          this.textureAirbrushSeedProjectionFrameLayerProxies?.(existing);
        }
        return existing;
      }
      const frame = this.textureAirbrushGpuProjectionFrame(options);
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
      const neighborPaintSeed = options.neighborPaintSeed || null;
      const neighborAllowsHit = (record, hit, material = null, materialIndex = null) => (
        this.textureAirbrushNeighborHitAllowed?.(
          neighborPaintSeed,
          record,
          hit,
          material,
          materialIndex
        ) !== false
      );
      const neighborAllowsPass = (pass) => (
        this.textureAirbrushNeighborPassAllowed?.(neighborPaintSeed, pass) !== false
      );
      const canReuseNeighborCachedPasses = this.textureAirbrushNeighborCanReuseCachedPasses?.(neighborPaintSeed) !== false;
      this.textureAirbrushSeedProjectionFramePaintPasses?.(projectionFrame);
      const stroke = textureAirbrushScreenStrokeFromEvent(event, rect, options);
      if (!stroke) {
        return 0;
      }
      let screenCenter = stroke.center;
      let screenStart = stroke.start;
      let screenSegments = stroke.strokeSegments;
      let brushRadius = Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24);
      for (const segment of screenSegments) {
        const segmentRadius = Number(segment?.radiusPixels);
        if (Number.isFinite(segmentRadius) && segmentRadius > 0) {
          brushRadius = Math.max(brushRadius, segmentRadius);
        }
      }
      const neighborPointAllowed = (point = null) => {
        if (!neighborPaintSeed?.enabled) {
          return true;
        }
        if (!textureAirbrushPointInRect(point, rect)) {
          return false;
        }
        this.pointer.x = (point.x / rect.width) * 2 - 1;
        this.pointer.y = -(point.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        for (const hit of textureAirbrushFrontIntersections(intersections)) {
          const record = recordByObject.get(hit.object);
          const materialIndex = hit.face?.materialIndex ?? 0;
          const material = record ? this.clonePaintMaterialForHit?.(record, hit) : null;
          if (neighborAllowsHit(record, hit, material, materialIndex)) {
            return true;
          }
        }
        return false;
      };
      if (neighborPaintSeed?.enabled && !neighborPaintSeed.component?.size) {
        screenSegments = screenSegments.filter((segment) => (
          neighborPointAllowed(segment?.start)
          && neighborPointAllowed(segment?.end)
        ));
        if (!screenSegments.length) {
          return 0;
        }
        screenStart = screenSegments[0]?.start || screenStart;
        screenCenter = screenSegments.at(-1)?.end || screenCenter;
        stroke.start = screenStart;
        stroke.center = screenCenter;
        stroke.strokeSegments = screenSegments;
      }
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
        if (!pass) {
          return;
        }
        const strokeUndo = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo || null;
        if (pass.undoCaptured === true && (pass.strokeUndo || null) === strokeUndo) {
          if (!pass.strokeSourceSnapshot) {
            pass.strokeSourceSnapshot = this.texturePaintGpuStrokeSourceSnapshot?.(
              pass.record,
              pass.material,
              pass.targetEntry,
              pass.materialIndex
            ) || null;
            pass.strokeSourceRevision = this.texturePaintGpuTargetRevision?.(pass.targetEntry)
              ?? Math.max(0, Math.floor(Number(pass.targetEntry?.paintRevision) || 0));
          }
          return;
        }
        pass.strokeUndo = strokeUndo;
        pass.strokeSourceSnapshot = null;
        pass.strokeSourceRevision = null;
        pass.undoCaptured = this.captureTexturePaintGpuUndoTarget?.(
          pass.record,
          pass.material,
          pass.targetEntry,
          pass.materialIndex
        ) !== false;
        pass.strokeSourceSnapshot = this.texturePaintGpuStrokeSourceSnapshot?.(
          pass.record,
          pass.material,
          pass.targetEntry,
          pass.materialIndex
        ) || null;
        pass.strokeSourceRevision = this.texturePaintGpuTargetRevision?.(pass.targetEntry)
          ?? Math.max(0, Math.floor(Number(pass.targetEntry?.paintRevision) || 0));
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
        const layerMode = this.activeTool === "airbrush" && this.texturePaintLayerModeActive?.() === true;
        const targetEntry = layerMode
          ? projectionSeedTargetEntryForMaterial(this, material)
            || this.textureAirbrushGpuTargetForMaterial(material)
          : this.textureAirbrushGpuTargetForMaterial(material);
        if (!targetEntry) {
          return null;
        }
        const strokeUndo = this.texturePaintActiveStrokeUndo?.() || this.texturePaintStrokeUndo || null;
        const undoCaptured = this.captureTexturePaintGpuUndoTarget?.(record, material, targetEntry, materialIndex) !== false;
        const strokeSourceSnapshot = this.texturePaintGpuStrokeSourceSnapshot?.(
          record,
          material,
          targetEntry,
          materialIndex
        ) || null;
        const pass = { key, record, materialIndex, material, targetEntry };
        pass.undoCaptured = undoCaptured;
        pass.strokeUndo = strokeUndo;
        pass.strokeSourceSnapshot = strokeSourceSnapshot;
        pass.strokeSourceRevision = this.texturePaintGpuTargetRevision?.(targetEntry)
          ?? Math.max(0, Math.floor(Number(targetEntry?.paintRevision) || 0));
        paintPasses.set(key, pass);
        projectionFrame?.paintPassCache?.set(key, pass);
        return pass;
      };
      if (neighborPaintSeed?.enabled && neighborPaintSeed.component?.size) {
        const seedMaterialIndex = Number.isInteger(neighborPaintSeed.materialIndex)
          ? neighborPaintSeed.materialIndex
          : 0;
        const seedMaterial = neighborPaintSeed.material
          || materialsForProjectionRecord(neighborPaintSeed.record)[seedMaterialIndex]
          || null;
        const seedPass = addPaintPass(neighborPaintSeed.record, seedMaterialIndex, seedMaterial);
        if (seedPass && neighborAllowsPass(seedPass)) {
          paintPasses.set(seedPass.key, seedPass);
        }
      }
      const cachedPasses = projectionFrame?.paintPassCache
        ? [...projectionFrame.paintPassCache.values()].filter(neighborAllowsPass)
        : [];
      const paintPassCacheComplete = projectionFrame?.paintPassCacheSeeded === true
        && projectionFrame?.seedPaintPasses !== false;
      const hasLayerCachedPasses = cachedPasses.some((pass) => pass?.targetEntry?.layerMode === true);
      const canReusePartialLayerPasses = options.reusePartialLayerPasses === true
        && hasLayerCachedPasses
        && projectionFrame?.paintPassCache
        && options.reusePaintPasses !== false;
      const cachedPassCount = (paintPassCacheComplete || canReusePartialLayerPasses)
        ? cachedPasses.length
        : 0;
      const spacingPercent = Number(options.spacing);
      const shouldRenderCachedContinuousPasses = Number.isFinite(spacingPercent)
        && spacingPercent <= 10
        && cachedPassCount
        && options.reusePaintPasses !== false
        && canReuseNeighborCachedPasses
        && (
          cachedPassCount <= 1
          || hasLayerCachedPasses !== true
          || options.renderAllCachedPasses === true
        );
      if (shouldRenderCachedContinuousPasses) {
        for (const pass of cachedPasses) {
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
          if (canReuseNeighborCachedPasses && probePaintPassCache?.has(probeKey)) {
            for (const pass of probePaintPassCache.get(probeKey) || []) {
              if (neighborAllowsPass(pass)) {
                paintPasses.set(pass.key, pass);
              }
            }
            continue;
          }
          const cachedLayerHitPasses = canReuseNeighborCachedPasses
            ? this.textureAirbrushCachedLayerHitPassesForProbe?.(
                projectionFrame,
                probe,
                { radiusPixels: brushRadius }
              ) || []
            : [];
          if (cachedLayerHitPasses.length) {
            for (const pass of cachedLayerHitPasses) {
              if (neighborAllowsPass(pass)) {
                paintPasses.set(pass.key, pass);
              }
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
            if (!neighborAllowsHit(record, hit, material, materialIndex)) {
              continue;
            }
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
        const segmentRadius = Math.max(1, Number(segment.radiusPixels) || brushRadius);
        if (Array.isArray(shaderMaterial.uniforms.strokeRadii?.value)) {
          shaderMaterial.uniforms.strokeRadii.value[index] = segmentRadius;
        }
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
      const previousShaderBlending = shaderMaterial.blending;
      const previousShaderTransparent = shaderMaterial.transparent;
      this.renderer.autoClear = false;
      const layerCompositeMaterials = new Set();
      const firstPaintDisplayMaterials = new Set();
      for (const pass of paintPasses.values()) {
        ensurePaintPassUndoCaptured(pass);
        const strokeSourceSnapshot = options.strokeOpacityCap === false
          ? null
          : pass.strokeSourceSnapshot || this.texturePaintGpuStrokeSourceSnapshot?.(
            pass.record,
            pass.material,
            pass.targetEntry,
            pass.materialIndex
          ) || null;
        const strokeSourceTexture = strokeSourceSnapshot?.texture || null;
        const useStrokeSource = Boolean(strokeSourceSnapshot && (strokeSourceTexture || strokeSourceSnapshot.clear === true));
        const currentTargetRevision = this.texturePaintGpuTargetRevision?.(pass.targetEntry)
          ?? Math.max(0, Math.floor(Number(pass.targetEntry?.paintRevision) || 0));
        const strokeSourceRevision = Math.max(0, Math.floor(Number(pass.strokeSourceRevision) || 0));
        const needsCurrentTargetCompare = useStrokeSource && currentTargetRevision > strokeSourceRevision;
        const currentTargetSnapshot = needsCurrentTargetCompare
          ? this.textureAirbrushCurrentTargetSnapshot?.(pass.targetEntry) || null
          : null;
        const currentTargetTexture = currentTargetSnapshot?.texture || null;
        const uniforms = shaderMaterial.uniforms || {};
        if (uniforms.strokeSourceTexture) {
          uniforms.strokeSourceTexture.value = strokeSourceTexture;
        }
        if (uniforms.useStrokeSourceTexture) {
          uniforms.useStrokeSourceTexture.value = useStrokeSource;
        }
        if (uniforms.currentTargetTexture) {
          uniforms.currentTargetTexture.value = currentTargetTexture;
        }
        if (uniforms.useCurrentTargetTexture) {
          uniforms.useCurrentTargetTexture.value = Boolean(currentTargetTexture);
        }
        if (uniforms.strokeSourceClear) {
          uniforms.strokeSourceClear.value = strokeSourceSnapshot?.clear === true;
        }
        if (uniforms.eraseMode) {
          uniforms.eraseMode.value = options.erase === true;
        }
        const useNeighborMask = Boolean(
          neighborPaintSeed?.enabled
          && this.textureAirbrushNeighborGpuMaskAttribute?.(neighborPaintSeed, pass.record)
        );
        const neighborSeedNormal = useNeighborMask
          ? normalizedProjectionNormal(neighborPaintSeed?.seedNormal)
          : null;
        if (uniforms.useNeighborMask) {
          uniforms.useNeighborMask.value = useNeighborMask;
        }
        if (uniforms.useNeighborNormalMask) {
          uniforms.useNeighborNormalMask.value = Boolean(neighborSeedNormal);
        }
        if (uniforms.neighborSeedNormal && neighborSeedNormal) {
          uniforms.neighborSeedNormal.value.set(
            neighborSeedNormal.x,
            neighborSeedNormal.y,
            neighborSeedNormal.z
          );
        }
        if (uniforms.neighborNormalThreshold) {
          uniforms.neighborNormalThreshold.value = 0;
        }
        if (uniforms.neighborViewNormalThreshold) {
          const viewThreshold = Number(options.neighborViewNormalThreshold);
          uniforms.neighborViewNormalThreshold.value = Number.isFinite(viewThreshold)
            ? Math.max(0, Math.min(1, viewThreshold))
            : TEXTURE_AIRBRUSH_NEIGHBOR_VIEW_NORMAL_THRESHOLD;
        }
        if (uniforms.paintOccludedNeighborFragments) {
          uniforms.paintOccludedNeighborFragments.value = useNeighborMask;
        }
        shaderMaterial.blending = useStrokeSource
          ? THREE.NoBlending
          : THREE.NormalBlending;
        shaderMaterial.transparent = !useStrokeSource;
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
        const liveCompositeTarget = pass.targetEntry?.layerMode === true && options.deferLayerComposite === true
          ? this.texturePaintLiveCompositeTargetForLayerGpuPaint?.(pass.material, pass.targetEntry)
            || this.texturePaintLiveUnderlayTargetForLayerGpuPaint?.(pass.material, pass.targetEntry)
          : null;
        const bleedOffsets = this.textureAirbrushGpuUvBleedOffsets?.(pass.targetEntry, brushRadius) || [new THREE.Vector2()];
        for (const offset of bleedOffsets) {
          shaderMaterial.uniforms.uvOffset.value.copy(offset);
          this.renderer.setRenderTarget(pass.targetEntry.target);
          this.renderer.render(scene, this.textureAirbrushGpuCopyCamera);
          if (
            liveCompositeTarget?.target
            && liveCompositeTarget.target !== pass.targetEntry.target
            && liveCompositeTarget.skipLiveBrushRender !== true
          ) {
            const layerOpacity = Number(liveCompositeTarget.activeLayerOpacity);
            const shouldVisualBlendLivePatch = Number.isFinite(layerOpacity) && layerOpacity >= 0 && layerOpacity < 0.9999;
            const previousBrushOpacity = shaderMaterial.uniforms.brushOpacity.value;
            const previousUseStrokeSourceTexture = shaderMaterial.uniforms.useStrokeSourceTexture?.value;
            const previousUseCurrentTargetTexture = shaderMaterial.uniforms.useCurrentTargetTexture?.value;
            const previousStrokeSourceClear = shaderMaterial.uniforms.strokeSourceClear?.value;
            const previousEraseMode = shaderMaterial.uniforms.eraseMode?.value;
            const previousLivePatchBlending = shaderMaterial.blending;
            const previousLivePatchTransparent = shaderMaterial.transparent;
            if (shouldVisualBlendLivePatch) {
              const opacityScale = Number.isFinite(layerOpacity) && layerOpacity >= 0
                ? layerOpacity
                : 1;
              shaderMaterial.uniforms.brushOpacity.value = previousBrushOpacity * opacityScale;
              if (shaderMaterial.uniforms.useStrokeSourceTexture) {
                shaderMaterial.uniforms.useStrokeSourceTexture.value = false;
              }
              if (shaderMaterial.uniforms.useCurrentTargetTexture) {
                shaderMaterial.uniforms.useCurrentTargetTexture.value = false;
              }
              if (shaderMaterial.uniforms.strokeSourceClear) {
                shaderMaterial.uniforms.strokeSourceClear.value = false;
              }
              if (shaderMaterial.uniforms.eraseMode) {
                shaderMaterial.uniforms.eraseMode.value = false;
              }
              shaderMaterial.blending = THREE.NormalBlending;
              shaderMaterial.transparent = true;
            }
            try {
              this.renderer.setRenderTarget(liveCompositeTarget.target);
              this.renderer.render(scene, this.textureAirbrushGpuCopyCamera);
            } finally {
              if (shouldVisualBlendLivePatch) {
                shaderMaterial.uniforms.brushOpacity.value = previousBrushOpacity;
                if (shaderMaterial.uniforms.useStrokeSourceTexture) {
                  shaderMaterial.uniforms.useStrokeSourceTexture.value = previousUseStrokeSourceTexture;
                }
                if (shaderMaterial.uniforms.useCurrentTargetTexture) {
                  shaderMaterial.uniforms.useCurrentTargetTexture.value = previousUseCurrentTargetTexture;
                }
                if (shaderMaterial.uniforms.strokeSourceClear) {
                  shaderMaterial.uniforms.strokeSourceClear.value = previousStrokeSourceClear;
                }
                if (shaderMaterial.uniforms.eraseMode) {
                  shaderMaterial.uniforms.eraseMode.value = previousEraseMode;
                }
                shaderMaterial.blending = previousLivePatchBlending;
                shaderMaterial.transparent = previousLivePatchTransparent;
              }
            }
          }
        }
        const wasEmptyLayerTarget = pass.targetEntry?.layerMode === true
          ? pass.targetEntry.emptyTransparent === true
            || pass.targetEntry.layer?.isEmpty === true
            || Math.max(0, Math.floor(Number(pass.targetEntry.paintRevision) || 0)) <= 0
          : false;
        this.markTexturePaintGpuTargetMutated?.(pass.targetEntry);
        if (pass.targetEntry?.layerMode === true) {
          const forceDisplayCompositeRequested = pass.targetEntry.forceDisplayCompositeOnce === true;
          const forceDisplayComposite = forceDisplayCompositeRequested
            && liveCompositeTarget?.shaderComposite !== true;
          if (forceDisplayCompositeRequested) {
            pass.targetEntry.forceDisplayCompositeOnce = false;
          }
          this.texturePaintActiveMaterial = pass.material;
          pass.targetEntry.emptyTransparent = false;
          if (pass.targetEntry.layer) {
            pass.targetEntry.layer.isEmpty = false;
          }
          const firstPaintNeedsExactDisplayRefresh = !forceDisplayComposite
            && wasEmptyLayerTarget;
          const firstPaintDisplayComposite = firstPaintNeedsExactDisplayRefresh
            && liveCompositeTarget?.shaderComposite !== true;
          if (firstPaintNeedsExactDisplayRefresh) {
            this.texturePaintNeedsExactFirstPaintDisplayRefresh = true;
            this.scheduleTexturePaintExactFirstPaintDisplayRefresh?.();
          }
          if (firstPaintDisplayComposite) {
            firstPaintDisplayMaterials.add(pass.material);
          }
          const liveBakedLayerDisplayRefreshed = !firstPaintDisplayComposite
            && liveCompositeTarget?.shaderComposite === true
            && this.texturePaintRefreshLiveBakedCompositeForLayerGpuPaint?.(
              pass.material,
              pass.targetEntry,
              liveCompositeTarget
            ) === true;
          const fastLayerDisplayRefreshed = !liveBakedLayerDisplayRefreshed
            && !firstPaintDisplayComposite
            && this.texturePaintFastMaterialLayerDisplay?.(pass.material, {
            changedLayer: pass.targetEntry.layer || null
          }) === true;
          if (!liveBakedLayerDisplayRefreshed && !fastLayerDisplayRefreshed && liveCompositeTarget?.shaderComposite === true) {
            this.texturePaintRestoreLiveLayerShaderDisplayState?.(
              pass.material,
              pass.targetEntry,
              liveCompositeTarget
            );
          }
          if (liveCompositeTarget?.underlayComposite === true) {
            this.texturePaintRefreshLiveUnderlayPatchForLayerGpuPaint?.(
              pass.material,
              pass.targetEntry,
              liveCompositeTarget
            );
            const liveLayerOpacity = Number(liveCompositeTarget.activeLayerOpacity);
            if (Number.isFinite(liveLayerOpacity) && liveLayerOpacity >= 0 && liveLayerOpacity < 0.9999) {
              this.queueTexturePaintLiveUnderlayRefresh?.(
                pass.material,
                liveCompositeTarget.displayTargetEntry
              );
            }
          }
          if (
            (
              liveCompositeTarget?.target
              || liveBakedLayerDisplayRefreshed
              || firstPaintDisplayComposite
              || fastLayerDisplayRefreshed
            )
            && !forceDisplayComposite
          ) {
            continue;
          }
          if (
            !forceDisplayComposite
            && options.deferLayerComposite === true
            && this.queueTexturePaintLayerGpuComposite?.(pass.material)
          ) {
            continue;
          }
          layerCompositeMaterials.add(pass.material);
        } else if (pass.targetEntry?.target?.texture && pass.material.map !== pass.targetEntry.target.texture) {
          pass.material.map = pass.targetEntry.target.texture;
          pass.material.needsUpdate = true;
        }
      }
      shaderMaterial.uniforms.uvOffset.value.set(0, 0);
      if (shaderMaterial.uniforms.strokeSourceTexture) {
        shaderMaterial.uniforms.strokeSourceTexture.value = null;
      }
      if (shaderMaterial.uniforms.useStrokeSourceTexture) {
        shaderMaterial.uniforms.useStrokeSourceTexture.value = false;
      }
      if (shaderMaterial.uniforms.currentTargetTexture) {
        shaderMaterial.uniforms.currentTargetTexture.value = null;
      }
      if (shaderMaterial.uniforms.useCurrentTargetTexture) {
        shaderMaterial.uniforms.useCurrentTargetTexture.value = false;
      }
      if (shaderMaterial.uniforms.strokeSourceClear) {
        shaderMaterial.uniforms.strokeSourceClear.value = false;
      }
      if (shaderMaterial.uniforms.eraseMode) {
        shaderMaterial.uniforms.eraseMode.value = false;
      }
      if (shaderMaterial.uniforms.useNeighborMask) {
        shaderMaterial.uniforms.useNeighborMask.value = false;
      }
      if (shaderMaterial.uniforms.useNeighborNormalMask) {
        shaderMaterial.uniforms.useNeighborNormalMask.value = false;
      }
      if (shaderMaterial.uniforms.paintOccludedNeighborFragments) {
        shaderMaterial.uniforms.paintOccludedNeighborFragments.value = false;
      }
      shaderMaterial.blending = previousShaderBlending;
      shaderMaterial.transparent = previousShaderTransparent;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      for (const material of firstPaintDisplayMaterials) {
        this.flushTexturePaintLayerGpuTargetsToCanvases?.({
          material,
          composite: false
        });
        this.texturePaintCompositeMaterialLayers?.(material, {
          skipGpuFlush: true,
          preferCpuDisplay: true
        });
      }
      for (const material of layerCompositeMaterials) {
        if (firstPaintDisplayMaterials.has(material)) {
          continue;
        }
        this.texturePaintCompositeMaterialLayerGpuTargets?.(material);
      }

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
