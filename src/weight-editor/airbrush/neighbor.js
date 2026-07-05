import { textureAirbrushRecordIdentity } from "./record-identity.js";

function faceVertexIndexes(face = null) {
  return [face?.a, face?.b, face?.c].filter((vertexIndex) => Number.isInteger(vertexIndex));
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
        component: this.textureAirbrushNeighborComponent?.(record, seedVertexIndex) || null
      };
      seed.key = this.textureAirbrushNeighborSeedKey?.(seed) || "";
      return seed;
    },

    textureAirbrushNeighborPaintHitFromEvent(event = null, tool = this.activeTool) {
      if (!event || (tool !== "airbrush" && tool !== "texture-eraser")) {
        return null;
      }
      return this.texturePaintHitForEvent?.(event, tool, {
        refreshSkinnedBounds: false,
        allowAnimationProgressMismatch: this.painting === true,
        raycastFallbackOnScreenMiss: true
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
      const paintHit = this.textureAirbrushNeighborPaintHitFromEvent?.(event, tool) || null;
      return this.textureAirbrushSyncNeighborPaintSeedForHit?.(paintHit, options) || null;
    },

    textureAirbrushBeginNeighborPaintStroke(event = null, tool = this.activeTool) {
      return this.textureAirbrushSyncNeighborPaintSeedForEvent?.(event, tool, { reset: true }) || null;
    },

    textureAirbrushEndNeighborPaintStroke() {
      this.textureAirbrushActiveNeighborPaintSeed = null;
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
