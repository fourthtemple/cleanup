import { textureAirbrushRecordIdentity } from "./record-identity.js";
import {
  textureAirbrushInterpolateSurfaceAnchors,
  textureAirbrushPointWithSurfaceAnchor,
  textureAirbrushSurfaceAnchorFromPoint
} from "./surface-path.js";

function compactNeighborBridgePoints(points = [], limit = 96) {
  if (!Array.isArray(points) || points.length <= limit || limit < 2) {
    return points;
  }
  const compacted = [points[0]];
  const lastIndex = points.length - 1;
  for (let index = 1; index < limit - 1; index += 1) {
    compacted.push(points[Math.round(index * lastIndex / (limit - 1))]);
  }
  compacted.push(points[lastIndex]);
  points.splice(0, points.length, ...compacted);
  return points;
}

function neighborBridgePointsWithSurfaceAnchors(
  startPoint = null,
  pendingPoints = [],
  endPoint = null,
  endAnchor = null,
  resolveSurfaceAnchorAtPoint = null,
  projectAnchorAtPoint = null
) {
  const points = [
    textureAirbrushPointWithSurfaceAnchor(startPoint, textureAirbrushSurfaceAnchorFromPoint(startPoint)),
    ...(Array.isArray(pendingPoints) ? pendingPoints : []).map((point) => (
      textureAirbrushPointWithSurfaceAnchor(point, textureAirbrushSurfaceAnchorFromPoint(point))
    )),
    textureAirbrushPointWithSurfaceAnchor(endPoint, endAnchor)
  ].filter(Boolean);
  if (points.length < 3) {
    return points.slice(1, -1);
  }
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + Math.hypot(
      points[index].clientX - points[index - 1].clientX,
      points[index].clientY - points[index - 1].clientY
    ));
  }
  const anchors = points.map((point, index) => (
    textureAirbrushSurfaceAnchorFromPoint(point)
    || (
      index > 0
      && index < points.length - 1
      && typeof resolveSurfaceAnchorAtPoint === "function"
        ? resolveSurfaceAnchorAtPoint(point, index, points) || null
        : null
    )
  ));
  const previousAnchorIndexes = [];
  let previousAnchorIndex = -1;
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index]) {
      previousAnchorIndex = index;
    }
    previousAnchorIndexes[index] = previousAnchorIndex;
  }
  const nextAnchorIndexes = [];
  let nextAnchorIndex = -1;
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    if (anchors[index]) {
      nextAnchorIndex = index;
    }
    nextAnchorIndexes[index] = nextAnchorIndex;
  }
  return points.slice(1, -1).map((point, offset) => {
    const index = offset + 1;
    let anchor = anchors[index];
    if (!anchor) {
      const leftIndex = previousAnchorIndexes[index];
      const rightIndex = nextAnchorIndexes[index];
      if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) {
        const span = cumulative[rightIndex] - cumulative[leftIndex];
        const ratio = span > 0.000001
          ? (cumulative[index] - cumulative[leftIndex]) / span
          : (index - leftIndex) / (rightIndex - leftIndex);
        const interpolatedAnchor = textureAirbrushInterpolateSurfaceAnchors(
          anchors[leftIndex],
          anchors[rightIndex],
          ratio
        );
        anchor = typeof projectAnchorAtPoint === "function"
          ? projectAnchorAtPoint(point, interpolatedAnchor, ratio) || interpolatedAnchor
          : interpolatedAnchor;
      } else {
        anchor = anchors[leftIndex] || anchors[rightIndex] || null;
      }
    }
    return textureAirbrushPointWithSurfaceAnchor(point, anchor) || point;
  });
}

function faceVertexIndexes(face = null) {
  const vertices = Array.isArray(face?.vertices)
    ? face.vertices
    : [face?.a, face?.b, face?.c];
  return vertices.filter((vertexIndex) => Number.isInteger(vertexIndex));
}

function normalizedNormal(normal = null) {
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

function materialIdentity(material = null) {
  return material?.uuid || material?.id || "";
}

function editablePaintTargetsMatch(left = null, right = null) {
  return Boolean(
    left
    && right
    && (
      left === right
      || (left.canvas && left.canvas === right.canvas)
      || (left.texture && left.texture === right.texture)
      || (left.layer && left.layer === right.layer)
    )
  );
}

function recordsMatch(left = null, right = null) {
  return Boolean(
      left
      && right
      && (
        left === right
      || left.object === right.object
      )
  );
}

function roundedPositionValue(value = 0) {
  return Math.round(Number(value || 0) * 10000);
}

function attributeComponent(attribute = null, vertexIndex = 0, componentIndex = 0) {
  if (!attribute) {
    return null;
  }
  if (typeof attribute.getComponent === "function") {
    const value = attribute.getComponent(vertexIndex, componentIndex);
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }
  const itemSize = Math.max(1, Math.floor(Number(attribute.itemSize) || 1));
  const arrayIndex = vertexIndex * itemSize + componentIndex;
  if (!attribute.array || arrayIndex < 0 || arrayIndex >= attribute.array.length) {
    return null;
  }
  const value = Number(attribute.array[arrayIndex]);
  return Number.isFinite(value) ? value : null;
}

function skinSignatureForNeighborVertex(geometry = null, vertexIndex = 0) {
  const skinIndex = geometry?.attributes?.skinIndex || null;
  const skinWeight = geometry?.attributes?.skinWeight || null;
  if (!skinIndex || !skinWeight) {
    return "";
  }
  const itemSize = Math.min(
    Math.floor(Number(skinIndex.itemSize) || 0),
    Math.floor(Number(skinWeight.itemSize) || 0),
    4
  );
  const influences = [];
  for (let index = 0; index < itemSize; index += 1) {
    const weight = attributeComponent(skinWeight, vertexIndex, index) || 0;
    if (weight <= 0.0001) {
      continue;
    }
    influences.push(`${Math.round(attributeComponent(skinIndex, vertexIndex, index) || 0)}:${Math.round(weight * 10000)}`);
  }
  return influences.sort().join(",");
}

function textureNeighborPositionKey(record = null, vertexIndex = 0) {
  const position = record?.geometry?.attributes?.position || null;
  if (!position || vertexIndex < 0 || vertexIndex >= Math.max(0, Number(position.count) || 0)) {
    return "";
  }
  const x = attributeComponent(position, vertexIndex, 0);
  const y = attributeComponent(position, vertexIndex, 1);
  const z = attributeComponent(position, vertexIndex, 2);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return "";
  }
  return [
    roundedPositionValue(x),
    roundedPositionValue(y),
    roundedPositionValue(z),
    skinSignatureForNeighborVertex(record?.geometry, vertexIndex)
  ].join(":");
}

function neighborDeletedSignature(record = null) {
  const deleted = record?.deleted || null;
  const size = Math.max(0, Math.floor(Number(deleted?.size) || 0));
  if (!size) {
    return "0";
  }
  let hash = 2166136261;
  let sum = 0;
  let xor = 0;
  for (const value of deleted) {
    const vertexIndex = Math.max(0, Math.floor(Number(value) || 0));
    sum = (sum + vertexIndex) >>> 0;
    xor ^= vertexIndex;
    hash ^= vertexIndex;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${size}:${sum}:${xor >>> 0}:${hash >>> 0}`;
}

function neighborPositionSeamMapCurrent(record = null, position = null) {
  const state = record?.texturePaintNeighborPositionSeamMapState || null;
  return Boolean(
    state
    && state.position === position
    && state.vertexCount === Math.max(0, Math.floor(Number(position?.count) || 0))
    && state.positionVersion === Math.max(0, Math.floor(Number(position?.version) || 0))
    && state.skinIndex === (record?.geometry?.attributes?.skinIndex || null)
    && state.skinWeight === (record?.geometry?.attributes?.skinWeight || null)
    && state.map instanceof Map
  );
}

function neighborComponentStateCurrent(record = null, position = null, deletedSignature = "") {
  const state = record?.texturePaintNeighborComponentState || null;
  return Boolean(
    state
    && state.position === position
    && state.vertexNeighbors === record?.vertexNeighbors
    && state.seamMap === (record?.texturePaintNeighborPositionSeamMapState?.map || null)
    && state.vertexCount === Math.max(0, Math.floor(Number(position?.count) || 0))
    && state.positionVersion === Math.max(0, Math.floor(Number(position?.version) || 0))
    && state.deletedSignature === deletedSignature
    && state.componentIds
    && Array.isArray(state.components)
  );
}

function firstValidFaceVertex(record = null, face = null) {
  for (const vertexIndex of faceVertexIndexes(face)) {
    if (!record?.deleted?.has?.(vertexIndex)) {
      return vertexIndex;
    }
  }
  return null;
}

export function installTextureAirbrushNeighborPaintMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    texturePaintNeighborModeEnabled() {
      return this.texturePaintNeighborEnabled === true
        || this.texturePaintNeighborToggle?.checked === true
        || this.texturePaintNeighborToggle?.getAttribute?.("aria-pressed") === "true";
    },

    setTexturePaintNeighborMode(enabled = false, options = {}) {
      const nextEnabled = enabled === true;
      this.texturePaintNeighborEnabled = nextEnabled;
      if (this.texturePaintNeighborToggle) {
        this.texturePaintNeighborToggle.checked = nextEnabled;
        this.texturePaintNeighborToggle.classList.toggle("is-active", nextEnabled);
      }
      this.textureAirbrushActiveNeighborPaintSeed = null;
      this.textureAirbrushNeighborScreenStrokeFrontier = null;
      this.textureAirbrushNeighborScreenStrokeBreakPending = false;
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = null;
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
      this.textureAirbrushNeighborScreenStrokeMissPending = null;
      this.textureAirbrushNeighborScreenStrokePendingPoints = [];
      this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
      this.textureAirbrushResetLiveProjectionFrame?.({ keepCurrent: false });
      if (options.status !== false) {
        this.setStatus?.(nextEnabled
          ? "Texture paint neighbor mode: on"
          : "Texture paint neighbor mode: off");
      }
      return nextEnabled;
    },

    syncTexturePaintNeighborMode() {
      const nextEnabled = typeof this.texturePaintNeighborEnabled === "boolean"
        ? this.texturePaintNeighborEnabled
        : true;
      this.setTexturePaintNeighborMode?.(nextEnabled, { status: false });
    },

    textureAirbrushEnsureNeighborTopology(record = null) {
      if (!record?.geometry?.attributes?.position) {
        return false;
      }
      if (!record.vertexNeighbors && typeof this.buildVertexNeighborMap === "function") {
        record.vertexNeighbors = this.buildVertexNeighborMap(record.geometry);
      }
      return Array.isArray(record.vertexNeighbors);
    },

    textureAirbrushNeighborLinkedVertices(record = null, vertexIndex = null) {
      if (!record || !Number.isInteger(vertexIndex)) {
        return [];
      }
      const map = this.textureAirbrushNeighborPositionSeamMap?.(record);
      const linked = map?.get(vertexIndex)
        || (typeof this.linkedSeamVertices === "function"
          ? this.linkedSeamVertices(record, vertexIndex)
          : null);
      return linked?.length ? linked : [vertexIndex];
    },

    textureAirbrushNeighborPositionSeamMap(record = null) {
      const position = record?.geometry?.attributes?.position || null;
      const vertexCount = Math.max(0, Math.floor(Number(position?.count) || 0));
      if (!record || !position || !vertexCount) {
        return null;
      }
      if (neighborPositionSeamMapCurrent(record, position)) {
        return record.texturePaintNeighborPositionSeamMapState.map;
      }
      const groups = new Map();
      for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
        const key = textureNeighborPositionKey(record, vertexIndex);
        if (!key) {
          continue;
        }
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(vertexIndex);
      }
      const map = new Map();
      for (const group of groups.values()) {
        if (group.length < 2) {
          continue;
        }
        for (const vertexIndex of group) {
          map.set(vertexIndex, group);
        }
      }
      record.texturePaintNeighborPositionSeamMap = map;
      record.texturePaintNeighborPositionSeamMapState = {
        position,
        vertexCount,
        positionVersion: Math.max(0, Math.floor(Number(position.version) || 0)),
        skinIndex: record.geometry?.attributes?.skinIndex || null,
        skinWeight: record.geometry?.attributes?.skinWeight || null,
        map
      };
      record.texturePaintNeighborComponentState = null;
      return map;
    },

    textureAirbrushNeighborComponentState(record = null) {
      const position = record?.geometry?.attributes?.position || null;
      const vertexCount = Math.max(0, Math.floor(Number(position?.count) || 0));
      if (!record || !position || !vertexCount) {
        return null;
      }
      this.textureAirbrushEnsureNeighborTopology?.(record);
      const seamMap = this.textureAirbrushNeighborPositionSeamMap?.(record) || null;
      const deletedSignature = neighborDeletedSignature(record);
      if (neighborComponentStateCurrent(record, position, deletedSignature)) {
        return record.texturePaintNeighborComponentState;
      }
      const deleted = record.deleted || null;
      const componentIds = new Int32Array(vertexCount);
      componentIds.fill(-1);
      const components = [];
      const enqueue = (queue, componentId, vertexIndex) => {
        if (
          !Number.isInteger(vertexIndex)
          || vertexIndex < 0
          || vertexIndex >= vertexCount
          || componentIds[vertexIndex] !== -1
          || deleted?.has?.(vertexIndex)
        ) {
          return false;
        }
        componentIds[vertexIndex] = componentId;
        queue.push(vertexIndex);
        return true;
      };
      for (let seedVertexIndex = 0; seedVertexIndex < vertexCount; seedVertexIndex += 1) {
        if (componentIds[seedVertexIndex] !== -1 || deleted?.has?.(seedVertexIndex)) {
          continue;
        }
        const componentId = components.length;
        const queue = [];
        const vertices = [];
        enqueue(queue, componentId, seedVertexIndex);
        for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
          const vertexIndex = queue[queueIndex];
          vertices.push(vertexIndex);
          for (const candidateIndex of this.textureAirbrushNeighborLinkedVertices(record, vertexIndex)) {
            enqueue(queue, componentId, candidateIndex);
          }
          for (const candidateIndex of record.vertexNeighbors?.[vertexIndex] || []) {
            enqueue(queue, componentId, candidateIndex);
          }
        }
        components.push(vertices);
      }
      const state = {
        position,
        positionVersion: Math.max(0, Math.floor(Number(position.version) || 0)),
        vertexCount,
        vertexNeighbors: record.vertexNeighbors || null,
        seamMap,
        deletedSignature,
        componentIds,
        components,
        componentSets: []
      };
      record.texturePaintNeighborComponentState = state;
      return state;
    },

    textureAirbrushNeighborComponentSet(record = null, componentId = -1) {
      const state = this.textureAirbrushNeighborComponentState?.(record) || null;
      const index = Math.floor(Number(componentId));
      if (!state || index < 0 || index >= state.components.length) {
        return null;
      }
      if (!state.componentSets[index]) {
        state.componentSets[index] = new Set(state.components[index]);
      }
      return state.componentSets[index];
    },

    textureAirbrushNeighborComponent(record = null, seedVertexIndex = null) {
      if (!record || !Number.isInteger(seedVertexIndex) || record.deleted?.has?.(seedVertexIndex)) {
        return null;
      }
      const state = this.textureAirbrushNeighborComponentState?.(record) || null;
      const componentId = state?.componentIds?.[seedVertexIndex] ?? -1;
      return this.textureAirbrushNeighborComponentSet?.(record, componentId) || null;
    },

    textureAirbrushPrewarmNeighborTopology(record = null, options = {}) {
      const records = record
        ? [record]
        : (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((candidate) => candidate?.geometry);
      const limit = record
        ? 1
        : Math.max(1, Math.floor(Number(options.limit ?? options.neighborTopologyLimit) || 4));
      let warmed = 0;
      for (const candidate of records.slice(0, limit)) {
        if (this.textureAirbrushNeighborComponentState?.(candidate)) {
          warmed += 1;
        }
      }
      return warmed;
    },

    textureAirbrushNeighborSeedKey(seed = null) {
      if (!seed?.enabled) {
        return "";
      }
      return [
        textureAirbrushRecordIdentity(seed.record),
        seed.materialIndex ?? 0,
        materialIdentity(seed.material) || "material",
        seed.seedVertexIndex ?? "surface"
      ].join(":");
    },

    textureAirbrushNeighborSeedFromHit(paintHit = null) {
      if (!this.texturePaintNeighborModeEnabled?.()) {
        return null;
      }
      const record = paintHit?.record || null;
      const hit = paintHit?.hit || null;
      const seedVertexIndex = firstValidFaceVertex(record, hit?.face);
      if (!record || !hit?.face || !Number.isInteger(seedVertexIndex)) {
        return null;
      }
      const material = this.clonePaintMaterialForHit?.(record, hit) || null;
      const materialIndex = hit.face?.materialIndex ?? 0;
      const editable = this.editableClonePaintTexture?.(material) || null;
      const seedNormal = normalizedNormal(hit.face?.normal);
      const componentState = this.textureAirbrushNeighborComponentState?.(record) || null;
      const componentId = Math.floor(Number(componentState?.componentIds?.[seedVertexIndex]));
      const seed = {
        enabled: true,
        record,
        object: record.object || null,
        geometry: record.geometry || null,
        material,
        materialIndex,
        editable,
        seedVertexIndex,
        seedNormal,
        componentId: Number.isFinite(componentId) && componentId >= 0 ? componentId : -1,
        component: Number.isFinite(componentId) && componentId >= 0
          ? this.textureAirbrushNeighborComponentSet?.(record, componentId) || null
          : this.textureAirbrushNeighborComponent?.(record, seedVertexIndex) || null
      };
      seed.key = this.textureAirbrushNeighborSeedKey?.(seed) || "";
      return seed;
    },

    textureAirbrushNeighborPaintHitFromEvent(event = null, tool = this.activeTool) {
      if (!event || (tool !== "airbrush" && tool !== "texture-eraser")) {
        return null;
      }
      const options = arguments[2] || {};
      const cacheKey = [
        tool,
        Math.round(Number(event.clientX) * 2) / 2,
        Math.round(Number(event.clientY) * 2) / 2,
        options.raycastFallbackOnScreenMiss === true ? "fallback" : "indexed"
      ].join(":");
      const cache = this.textureAirbrushNeighborPaintHitEventCache || null;
      if (cache?.key === cacheKey) {
        return cache.value || null;
      }
      const useRaycastFallback = options.raycastFallbackOnScreenMiss === true;
      const value = this.texturePaintHitForEvent?.(event, tool, {
        refreshSkinnedBounds: false,
        allowAnimationProgressMismatch: this.painting === true,
        raycastFallbackOnScreenMiss: useRaycastFallback,
        skipTransparentTextureHits: false
      }) || null;
      this.textureAirbrushNeighborPaintHitEventCache = { key: cacheKey, value };
      return value;
    },

    textureAirbrushNeighborFastPaintHitFromEvent(event = null, tool = this.activeTool) {
      if (!event || (tool !== "airbrush" && tool !== "texture-eraser")) {
        return null;
      }
      return this.texturePaintHitForEvent?.(event, tool, {
        refreshSkinnedBounds: false,
        allowAnimationProgressMismatch: this.painting === true,
        raycastFallbackOnScreenMiss: false,
        skipTransparentTextureHits: false
      }) || null;
    },

    textureAirbrushNeighborSeedFromEvent(event = null, tool = this.activeTool) {
      return this.textureAirbrushNeighborSeedFromHit?.(
        this.textureAirbrushNeighborPaintHitFromEvent?.(event, tool) || null
      ) || null;
    },

    textureAirbrushNeighborSeedAllowsPaintHit(seed = null, paintHit = null) {
      if (!seed?.enabled) {
        return true;
      }
      const record = paintHit?.record || null;
      const hit = paintHit?.hit || null;
      if (!record || !hit?.face) {
        return false;
      }
      const material = this.clonePaintMaterialForHit?.(record, hit) || null;
      const materialIndex = hit.face?.materialIndex ?? 0;
      return this.textureAirbrushNeighborHitAllowed?.(seed, record, hit, material, materialIndex) === true;
    },

    textureAirbrushBeginNeighborPaintFrontier(seed = null) {
      if (!seed?.enabled || !seed.record) {
        this.textureAirbrushNeighborScreenStrokeFrontier = null;
        return null;
      }
      const frontier = {
        record: seed.record,
        vertices: new Set()
      };
      this.textureAirbrushNeighborScreenStrokeFrontier = frontier;
      return frontier;
    },

    textureAirbrushNeighborPaintHitVertexSet(record = null, hit = null) {
      const vertices = new Set();
      if (!record || !hit?.face) {
        return vertices;
      }
      for (const vertexIndex of faceVertexIndexes(hit.face)) {
        vertices.add(vertexIndex);
        for (const linkedIndex of this.textureAirbrushNeighborLinkedVertices?.(record, vertexIndex) || [vertexIndex]) {
          vertices.add(linkedIndex);
        }
      }
      return vertices;
    },

    textureAirbrushNeighborFrontierTouchesCandidate(record = null, vertices = null, frontier = null, options = {}) {
      const anchors = frontier?.vertices || null;
      if (!anchors?.size) {
        return true;
      }
      if (!record || frontier.record !== record || !vertices?.size) {
        return false;
      }
      const visited = new Set();
      let wave = [...vertices];
      const maxHops = Math.max(1, Math.min(12, Math.floor(Number(options.maxHops) || 3)));
      const maxVisited = Math.max(64, Math.min(1024, Math.floor(Number(options.maxVisited) || 256)));
      for (let hop = 0; hop <= maxHops && wave.length && visited.size < maxVisited; hop += 1) {
        const nextWave = [];
        for (const vertexIndex of wave) {
          if (!Number.isInteger(vertexIndex) || visited.has(vertexIndex)) {
            continue;
          }
          visited.add(vertexIndex);
          if (anchors.has(vertexIndex)) {
            return true;
          }
          for (const linkedIndex of this.textureAirbrushNeighborLinkedVertices?.(record, vertexIndex) || [vertexIndex]) {
            if (anchors.has(linkedIndex)) {
              return true;
            }
            if (hop < maxHops && !visited.has(linkedIndex)) {
              nextWave.push(linkedIndex);
            }
          }
          if (hop >= maxHops) {
            continue;
          }
          for (const neighborIndex of record.vertexNeighbors?.[vertexIndex] || []) {
            if (!visited.has(neighborIndex)) {
              nextWave.push(neighborIndex);
            }
          }
        }
        wave = nextWave;
      }
      return false;
    },

    textureAirbrushNeighborPaintHitTouchesFrontier(seed = null, paintHit = null) {
      if (!seed?.enabled) {
        return true;
      }
      const record = paintHit?.record || null;
      const hit = paintHit?.hit || null;
      const vertices = this.textureAirbrushNeighborPaintHitVertexSet?.(record, hit) || new Set();
      const frontier = this.textureAirbrushNeighborScreenStrokeFrontier || null;
      return this.textureAirbrushNeighborFrontierTouchesCandidate?.(record, vertices, frontier) === true;
    },

    textureAirbrushNeighborPreSmoothedBatchEndpointState(event = null, tool = this.activeTool) {
      const active = this.texturePaintNeighborModeEnabled?.() === true
        && (tool === "airbrush" || tool === "texture-eraser");
      const seed = this.textureAirbrushActiveNeighborPaintSeed || null;
      if (!active || !seed?.enabled || !event) {
        return { active, decisive: false, allowed: true, seed };
      }
      const paintHit = this.textureAirbrushNeighborPaintHitFromEvent?.(event, tool, {
        raycastFallbackOnScreenMiss: false
      }) || null;
      if (!paintHit?.record || !paintHit?.hit?.face) {
        return { active: true, decisive: true, allowed: false, reason: "missing-hit", paintHit, seed };
      }
      if (this.textureAirbrushNeighborSeedAllowsPaintHit?.(seed, paintHit) !== true) {
        return { active: true, decisive: true, allowed: false, reason: "disconnected", paintHit, seed };
      }
      if (this.textureAirbrushNeighborPaintHitTouchesFrontier?.(seed, paintHit) === false) {
        return { active: true, decisive: true, allowed: false, reason: "frontier", paintHit, seed };
      }
      return { active: true, decisive: true, allowed: true, paintHit, seed };
    },

    textureAirbrushHoldPreSmoothedNeighborBatch(events = []) {
      const lastAccepted = this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint || null;
      if (!Number.isFinite(lastAccepted?.clientX) || !Number.isFinite(lastAccepted?.clientY)) {
        return false;
      }
      const pendingPoints = this.textureAirbrushNeighborScreenStrokePendingPoints ||= [];
      let added = false;
      for (const event of Array.isArray(events) ? events : []) {
        if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
          continue;
        }
        const previous = pendingPoints.at(-1) || lastAccepted;
        if (Math.hypot(event.clientX - previous.clientX, event.clientY - previous.clientY) <= 0.01) {
          continue;
        }
        pendingPoints.push({ clientX: event.clientX, clientY: event.clientY });
        added = true;
      }
      if (!added) {
        return false;
      }
      if (pendingPoints.length > 96) {
        compactNeighborBridgePoints(pendingPoints);
      }
      const endpoint = pendingPoints.at(-1);
      this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = true;
      this.textureAirbrushNeighborScreenStrokeMissPending = {
        clientX: endpoint.clientX,
        clientY: endpoint.clientY,
        distanceFromAccepted: Math.hypot(
          endpoint.clientX - lastAccepted.clientX,
          endpoint.clientY - lastAccepted.clientY
        ),
        reason: "pre-smoothed"
      };
      return true;
    },

    textureAirbrushRecordNeighborPaintHit(seed = null, paintHit = null) {
      if (!seed?.enabled || !paintHit?.record || !paintHit?.hit?.face) {
        return false;
      }
      let frontier = this.textureAirbrushNeighborScreenStrokeFrontier || null;
      if (!frontier || frontier.record !== seed.record) {
        frontier = this.textureAirbrushBeginNeighborPaintFrontier?.(seed) || null;
      }
      if (!frontier) {
        return false;
      }
      const vertices = this.textureAirbrushNeighborPaintHitVertexSet?.(paintHit.record, paintHit.hit) || new Set();
      for (const vertexIndex of vertices) {
        frontier.vertices.add(vertexIndex);
      }
      return vertices.size > 0;
    },

    textureAirbrushNeighborScreenSampleState(event = null, options = {}) {
      const neighborPaintActive = this.texturePaintNeighborModeEnabled?.() === true
        && (this.activeTool === "airbrush" || this.activeTool === "texture-eraser");
      if (!neighborPaintActive) {
        this.textureAirbrushNeighborScreenStrokeBreakPending = false;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = null;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
        this.textureAirbrushNeighborScreenStrokeMissPending = null;
        this.textureAirbrushNeighborScreenStrokePendingPoints = [];
        this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
        return { active: false, allowed: true, resetAfterBreak: false, reason: "inactive" };
      }
      if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
        this.textureAirbrushNeighborScreenStrokeBreakPending = true;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
        this.textureAirbrushNeighborScreenStrokePendingPoints = [];
        this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
        this.textureAirbrushResetStrokeSpacing?.();
        return { active: true, allowed: false, resetAfterBreak: false, reason: "missing-event" };
      }
      if (
        typeof this.textureAirbrushNeighborPaintHitFromEvent !== "function"
        || typeof this.textureAirbrushNeighborSeedAllowsPaintHit !== "function"
      ) {
        return {
          active: true,
          allowed: true,
          resetAfterBreak: this.textureAirbrushNeighborScreenStrokeBreakPending === true,
          seed: this.textureAirbrushActiveNeighborPaintSeed || null,
          reason: "unavailable-gate"
        };
      }
      const paintHit = this.textureAirbrushNeighborPaintHitFromEvent(event, this.activeTool, {
        raycastFallbackOnScreenMiss: options.reset === true
      }) || null;
      let seed = this.textureAirbrushActiveNeighborPaintSeed || null;
      if (!seed?.enabled) {
        seed = this.textureAirbrushSyncNeighborPaintSeedForHit?.(paintHit, { reset: options.reset === true })
          || null;
        if (seed?.enabled && options.reset === true) {
          this.textureAirbrushBeginNeighborPaintFrontier?.(seed);
        }
      }
      if (!seed?.enabled) {
        this.textureAirbrushNeighborScreenStrokeBreakPending = true;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
        this.textureAirbrushNeighborScreenStrokeMissPending = null;
        this.textureAirbrushNeighborScreenStrokePendingPoints = [];
        this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
        this.textureAirbrushResetStrokeSpacing?.();
        return {
          active: true,
          allowed: false,
          resetAfterBreak: false,
          reason: "missing-seed",
          paintHit,
          seed: null
        };
      }
      const lastAccepted = this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint || null;
      const radiusPixels = Math.max(
        1,
        Number(options.radiusPixels) || Number(this.textureBrushRadiusScreenPixels?.()) || 8
      );
      const hermiteBridgePending = this.textureAirbrushNeighborScreenStrokeHermiteBridgePending === true;
      const maxBridgeDistance = hermiteBridgePending
        ? Math.max(96, Math.min(160, radiusPixels * 16))
        : Math.max(24, Math.min(64, radiusPixels * 6));
      const distanceFromAccepted = lastAccepted
        ? Math.hypot(event.clientX - lastAccepted.clientX, event.clientY - lastAccepted.clientY)
        : Infinity;
      const preserveLocalDiscontinuity = (reason = "missing-hit") => {
        if (distanceFromAccepted <= maxBridgeDistance) {
          const pendingPoints = this.textureAirbrushNeighborScreenStrokePendingPoints ||= [];
          const previousPoint = pendingPoints.at(-1) || null;
          if (
            !previousPoint
            || Math.hypot(event.clientX - previousPoint.clientX, event.clientY - previousPoint.clientY) > 0.01
          ) {
            pendingPoints.push({ clientX: event.clientX, clientY: event.clientY });
            if (pendingPoints.length > 96) {
              compactNeighborBridgePoints(pendingPoints);
            }
          }
          this.textureAirbrushNeighborScreenStrokeMissPending = {
            clientX: event.clientX,
            clientY: event.clientY,
            distanceFromAccepted,
            reason
          };
          return {
            active: true,
            allowed: false,
            preservePath: true,
            resetAfterBreak: false,
            reason,
            paintHit,
            seed
          };
        }
        this.textureAirbrushNeighborScreenStrokeBreakPending = true;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
        this.textureAirbrushNeighborScreenStrokeMissPending = null;
        this.textureAirbrushNeighborScreenStrokePendingPoints = [];
        this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
        this.textureAirbrushResetStrokeSpacing?.();
        return {
          active: true,
          allowed: false,
          preservePath: false,
          resetAfterBreak: false,
          reason: `${reason}-distance`,
          paintHit,
          seed
        };
      };
      if (!paintHit?.record || !paintHit?.hit?.face) {
        return preserveLocalDiscontinuity("missing-hit");
      }
      if (this.textureAirbrushNeighborSeedAllowsPaintHit(seed, paintHit) !== true) {
        this.textureAirbrushActiveNeighborPaintSeed = seed;
        return preserveLocalDiscontinuity("disconnected");
      }
      if (this.textureAirbrushNeighborPaintHitTouchesFrontier?.(seed, paintHit) === false) {
        this.textureAirbrushActiveNeighborPaintSeed = seed;
        if (hermiteBridgePending) {
          return preserveLocalDiscontinuity("frontier");
        }
        this.textureAirbrushNeighborScreenStrokeBreakPending = true;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
        this.textureAirbrushNeighborScreenStrokeMissPending = null;
        this.textureAirbrushNeighborScreenStrokePendingPoints = [];
        this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
        this.textureAirbrushResetStrokeSpacing?.();
        return { active: true, allowed: false, resetAfterBreak: false, reason: "frontier", paintHit, seed };
      }
      const resetAfterBreak = this.textureAirbrushNeighborScreenStrokeBreakPending === true;
      if (resetAfterBreak) {
        this.textureAirbrushNeighborScreenStrokeBreakPending = false;
        this.textureAirbrushNeighborPaintHitEventCache = null;
        this.textureAirbrushResetStrokeSpacing?.();
      }
      const previousAcceptedPaintHit = this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit || null;
      this.textureAirbrushRecordNeighborPaintHit?.(seed, paintHit);
      const surfaceAnchor = this.textureAirbrushSurfaceAnchorForPaintHit?.(
        paintHit,
        event,
        radiusPixels
      ) || null;
      const pendingPoints = Array.isArray(this.textureAirbrushNeighborScreenStrokePendingPoints)
        ? this.textureAirbrushNeighborScreenStrokePendingPoints
        : [];
      // Re-anchor held samples against a local frontier seeded from both ends.
      // This follows the returning surface without letting the path crawl onto an occluder.
      const bridgeFrontier = {
        record: seed.record,
        vertices: new Set()
      };
      for (const endpointHit of [previousAcceptedPaintHit, paintHit]) {
        const vertices = this.textureAirbrushNeighborPaintHitVertexSet?.(
          endpointHit?.record,
          endpointHit?.hit
        ) || new Set();
        for (const vertexIndex of vertices) {
          bridgeFrontier.vertices.add(vertexIndex);
        }
      }
      const bridgeAnchorProbeLimitPerEnd = 12;
      const bridgeProbeResults = new Map();
      const bridgePoints = neighborBridgePointsWithSurfaceAnchors(
        lastAccepted,
        pendingPoints,
        event,
        surfaceAnchor,
        (point, index, points) => {
          const interiorIndex = index - 1;
          const lastInteriorIndex = points.length - 3;
          if (
            interiorIndex >= bridgeAnchorProbeLimitPerEnd
            && interiorIndex <= lastInteriorIndex - bridgeAnchorProbeLimitPerEnd
          ) {
            return null;
          }
          const bridgePaintHit = this.textureAirbrushNeighborPaintHitFromEvent?.({
            clientX: point.clientX,
            clientY: point.clientY,
            pointerType: event.pointerType,
            buttons: event.buttons
          }, this.activeTool, {
            raycastFallbackOnScreenMiss: false
          }) || null;
          if (
            this.textureAirbrushNeighborSeedAllowsPaintHit?.(seed, bridgePaintHit) !== true
          ) {
            bridgeProbeResults.set(interiorIndex, bridgePaintHit ? "disconnected" : "missing-hit");
            return null;
          }
          const vertices = this.textureAirbrushNeighborPaintHitVertexSet?.(
            bridgePaintHit.record,
            bridgePaintHit.hit
          ) || new Set();
          if (
            this.textureAirbrushNeighborFrontierTouchesCandidate?.(
              bridgePaintHit.record,
              vertices,
              bridgeFrontier,
              { maxHops: 8, maxVisited: 512 }
            ) !== true
          ) {
            bridgeProbeResults.set(interiorIndex, "frontier");
            return null;
          }
          const bridgeSurfaceAnchor = this.textureAirbrushSurfaceAnchorForPaintHit?.(
            bridgePaintHit,
            point,
            radiusPixels
          ) || null;
          bridgeProbeResults.set(interiorIndex, bridgeSurfaceAnchor ? "anchor" : "missing-anchor");
          return bridgeSurfaceAnchor;
        },
        (point, anchor) => this.textureAirbrushSurfaceAnchorAtClientPoint?.(point, anchor) || anchor
      );
      let resolvedBridgePoints = bridgePoints;
      let resetBeforeAccepted = false;
      // A sustained no-hit run is a silhouette exit, not an occlusion. Keep
      // the verified edge samples and restart instead of projecting it inward.
      const missingProbeIndexes = [...bridgeProbeResults.entries()]
        .filter(([, result]) => result === "missing-hit")
        .map(([index]) => index)
        .sort((left, right) => left - right);
      if (missingProbeIndexes.length >= 2) {
        const firstMissingIndex = missingProbeIndexes[0];
        const lastMissingIndex = missingProbeIndexes.at(-1);
        const anchoredProbeIndexes = [...bridgeProbeResults.entries()]
          .filter(([, result]) => result === "anchor")
          .map(([index]) => index)
          .sort((left, right) => left - right);
        const lastAnchorBeforeGap = anchoredProbeIndexes
          .filter((index) => index < firstMissingIndex)
          .at(-1) ?? -1;
        const firstAnchorAfterGap = anchoredProbeIndexes
          .find((index) => index > lastMissingIndex) ?? pendingPoints.length;
        let gapPathDistance = 0;
        let gapPrevious = lastAnchorBeforeGap >= 0
          ? pendingPoints[lastAnchorBeforeGap]
          : lastAccepted;
        for (let index = lastAnchorBeforeGap + 1; index <= firstAnchorAfterGap; index += 1) {
          const gapCurrent = index < pendingPoints.length ? pendingPoints[index] : event;
          if (
            Number.isFinite(gapPrevious?.clientX)
            && Number.isFinite(gapPrevious?.clientY)
            && Number.isFinite(gapCurrent?.clientX)
            && Number.isFinite(gapCurrent?.clientY)
          ) {
            gapPathDistance += Math.hypot(
              gapCurrent.clientX - gapPrevious.clientX,
              gapCurrent.clientY - gapPrevious.clientY
            );
          }
          gapPrevious = gapCurrent;
        }
        if (gapPathDistance > Math.max(10, radiusPixels * 1.5)) {
          const retainedBridgePoints = bridgePoints
            .map((point, index) => ({ point, index }))
            .filter(({ index }) => index <= lastAnchorBeforeGap || index >= firstAnchorAfterGap);
          if (firstAnchorAfterGap < pendingPoints.length) {
            const suffix = retainedBridgePoints.find(({ index }) => index === firstAnchorAfterGap);
            if (suffix) {
              suffix.point = {
                ...suffix.point,
                textureAirbrushNeighborBridgeReset: true
              };
            }
          } else {
            resetBeforeAccepted = true;
          }
          resolvedBridgePoints = retainedBridgePoints.map(({ point }) => point);
        }
      }
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = textureAirbrushPointWithSurfaceAnchor(
        event,
        surfaceAnchor
      );
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = paintHit;
      this.textureAirbrushNeighborScreenStrokeMissPending = null;
      this.textureAirbrushNeighborScreenStrokePendingPoints = [];
      this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
      return {
        active: true,
        allowed: true,
        resetAfterBreak,
        paintHit,
        seed,
        ...(surfaceAnchor ? { surfaceAnchor } : {}),
        ...(resolvedBridgePoints.length ? { bridgePoints: resolvedBridgePoints } : {}),
        ...(resetBeforeAccepted ? { resetBeforeAccepted: true } : {})
      };
    },

    textureAirbrushSyncNeighborPaintSeedForHit(paintHit = null, options = {}) {
      const current = this.textureAirbrushActiveNeighborPaintSeed || null;
      if (current?.enabled && options.reset !== true) {
        return current;
      }
      const nextSeed = this.textureAirbrushNeighborSeedFromHit?.(paintHit) || null;
      if (nextSeed?.enabled) {
        this.textureAirbrushActiveNeighborPaintSeed = nextSeed;
        return nextSeed;
      }
      if (options.reset === true || !current?.enabled) {
        this.textureAirbrushActiveNeighborPaintSeed = null;
        return null;
      }
      return current;
    },

    textureAirbrushSyncNeighborPaintSeedForEvent(event = null, tool = this.activeTool, options = {}) {
      if (!this.texturePaintNeighborModeEnabled?.()) {
        return null;
      }
      const paintHit = this.textureAirbrushNeighborPaintHitFromEvent?.(event, tool, {
        raycastFallbackOnScreenMiss: true
      }) || null;
      return this.textureAirbrushSyncNeighborPaintSeedForHit?.(paintHit, options) || null;
    },

    textureAirbrushBeginNeighborPaintStroke(event = null, tool = this.activeTool) {
      if (!this.texturePaintNeighborModeEnabled?.()) {
        this.textureAirbrushNeighborScreenStrokeFrontier = null;
        this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
        return null;
      }
      const paintHit = this.textureAirbrushNeighborPaintHitFromEvent?.(event, tool) || null;
      const seed = this.textureAirbrushSyncNeighborPaintSeedForHit?.(paintHit, { reset: true }) || null;
      if (seed?.enabled) {
        this.textureAirbrushBeginNeighborPaintFrontier?.(seed);
        this.textureAirbrushRecordNeighborPaintHit?.(seed, paintHit);
      } else {
        this.textureAirbrushNeighborScreenStrokeFrontier = null;
      }
      this.textureAirbrushNeighborPaintHitEventCache = null;
      const radiusPixels = Math.max(1, Number(this.textureBrushRadiusScreenPixels?.()) || 8);
      const surfaceAnchor = seed?.enabled
        ? this.textureAirbrushSurfaceAnchorForPaintHit?.(paintHit, event, radiusPixels) || null
        : null;
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = seed?.enabled
        && Number.isFinite(event?.clientX)
        && Number.isFinite(event?.clientY)
        ? textureAirbrushPointWithSurfaceAnchor(event, surfaceAnchor)
        : null;
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = seed?.enabled
        ? paintHit
        : null;
      this.textureAirbrushNeighborScreenStrokeMissPending = null;
      this.textureAirbrushNeighborScreenStrokePendingPoints = [];
      this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
      return seed;
    },

    textureAirbrushEndNeighborPaintStroke() {
      this.textureAirbrushActiveNeighborPaintSeed = null;
      this.textureAirbrushNeighborScreenStrokeFrontier = null;
      this.textureAirbrushNeighborScreenStrokeBreakPending = false;
      this.textureAirbrushNeighborPaintHitEventCache = null;
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPoint = null;
      this.textureAirbrushNeighborScreenStrokeLastAcceptedPaintHit = null;
      this.textureAirbrushNeighborScreenStrokeMissPending = null;
      this.textureAirbrushNeighborScreenStrokePendingPoints = [];
      this.textureAirbrushNeighborScreenStrokeHermiteBridgePending = false;
    },

    textureAirbrushNeighborRecordMatches(seed = null, record = null) {
      return !seed?.enabled || recordsMatch(seed.record, record);
    },

    textureAirbrushNeighborPassAllowed(seed = null, pass = null) {
      if (!seed?.enabled) {
        return true;
      }
      if (!this.textureAirbrushNeighborRecordMatches?.(seed, pass?.record)) {
        return false;
      }
      // Neighbor mode broadens the eligible connected surface island only.
      // The projection shader still owns the normal-observability rule:
      // camera-facing normals may paint, normals pointing away from the camera
      // may not. Do not use this pass gate as a back-normal bypass.
	      if (seed.component?.size) {
	        return true;
	      }
	      const passMaterialMatchesSeed = !seed.material
	        || !pass?.material
	        || pass.material === seed.material
	        || editablePaintTargetsMatch(seed.editable, this.editableClonePaintTexture?.(pass.material) || null);
	      if (Number.isInteger(seed.materialIndex) && (pass?.materialIndex ?? 0) !== seed.materialIndex && !passMaterialMatchesSeed) {
	        return false;
	      }
	      return passMaterialMatchesSeed;
    },

    textureAirbrushNeighborCanReuseCachedPasses(seed = null) {
      return !seed?.enabled || !seed.component?.size;
    },

    textureAirbrushNeighborHitAllowed(seed = null, record = null, hit = null, material = null, materialIndex = null) {
      if (!seed?.enabled) {
        return true;
      }
      if (!this.textureAirbrushNeighborRecordMatches?.(seed, record)) {
        return false;
      }
      const hasConnectedComponent = seed.component?.size;
      const resolvedMaterialIndex = Number.isInteger(materialIndex)
        ? materialIndex
        : hit?.face?.materialIndex ?? 0;
	      const resolvedMaterial = material || (record && hit
	        ? this.clonePaintMaterialForHit?.(record, hit) || null
	        : null);
	      const resolvedEditable = resolvedMaterial
	        ? this.editableClonePaintTexture?.(resolvedMaterial) || null
	        : null;
	      const matchesSeedPaintTarget = editablePaintTargetsMatch(seed.editable, resolvedEditable);
	      if (!hasConnectedComponent && Number.isInteger(seed.materialIndex) && resolvedMaterialIndex !== seed.materialIndex && !matchesSeedPaintTarget) {
	        return false;
	      }
	      if (!hasConnectedComponent && seed.material && resolvedMaterial && resolvedMaterial !== seed.material) {
	        if (!matchesSeedPaintTarget) {
	          return false;
	        }
      }
      const hitNormal = normalizedNormal(hit?.face?.normal);
      if (!hasConnectedComponent && seed.seedNormal && hitNormal) {
        const normalDot = seed.seedNormal.x * hitNormal.x
          + seed.seedNormal.y * hitNormal.y
          + seed.seedNormal.z * hitNormal.z;
        if (normalDot < 0) {
          return false;
        }
      }
      if (!hasConnectedComponent) {
        return true;
      }
      const vertices = faceVertexIndexes(hit?.face);
      if (!vertices.length) {
        return false;
      }
      for (const vertexIndex of vertices) {
        if (seed.component.has(vertexIndex)) {
          continue;
        }
        const linkedVertices = this.textureAirbrushNeighborLinkedVertices(record, vertexIndex);
        if (linkedVertices.some((linkedIndex) => (
          linkedIndex !== vertexIndex
          && seed.component.has(linkedIndex)
        ))) {
          continue;
        }
        return false;
      }
      return true;
    }
  });
}
