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

function recordIdentity(record = null) {
  return record?.object?.uuid
    || record?.object?.id
    || record?.geometry?.uuid
    || record?.geometry?.id
    || "";
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
      this.setTexturePaintNeighborMode?.(this.texturePaintNeighborEnabled === true, { status: false });
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
      if (record.texturePaintNeighborPositionSeamMap) {
        return record.texturePaintNeighborPositionSeamMap;
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
      return map;
    },

    textureAirbrushNeighborComponent(record = null, seedVertexIndex = null) {
      if (!record || !Number.isInteger(seedVertexIndex) || record.deleted?.has?.(seedVertexIndex)) {
        return null;
      }
      this.textureAirbrushEnsureNeighborTopology?.(record);
      const component = new Set();
      const queue = [seedVertexIndex];
      while (queue.length) {
        const vertexIndex = queue.shift();
        if (component.has(vertexIndex) || record.deleted?.has?.(vertexIndex)) {
          continue;
        }
        component.add(vertexIndex);
        const candidates = [
          ...this.textureAirbrushNeighborLinkedVertices(record, vertexIndex),
          ...(record.vertexNeighbors?.[vertexIndex] || [])
        ];
        for (const candidateIndex of candidates) {
          if (!component.has(candidateIndex) && !record.deleted?.has?.(candidateIndex)) {
            queue.push(candidateIndex);
          }
        }
      }
      return component;
    },

    textureAirbrushNeighborSeedKey(seed = null) {
      if (!seed?.enabled) {
        return "";
      }
      return [
        recordIdentity(seed.record) || "record",
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
      const seedNormal = normalizedNormal(hit.face?.normal);
      const seed = {
        enabled: true,
        record,
        object: record.object || null,
        geometry: record.geometry || null,
        material,
        materialIndex,
        seedVertexIndex,
        seedNormal,
        component: this.textureAirbrushNeighborComponent?.(record, seedVertexIndex) || null
      };
      seed.key = this.textureAirbrushNeighborSeedKey?.(seed) || "";
      return seed;
    },

    textureAirbrushNeighborSeedFromEvent(event = null, tool = this.activeTool) {
      if (!event || (tool !== "airbrush" && tool !== "texture-eraser")) {
        return null;
      }
      return this.textureAirbrushNeighborSeedFromHit?.(
        this.texturePaintHitForEvent?.(event, tool) || null
      ) || null;
    },

    textureAirbrushBeginNeighborPaintStroke(event = null, tool = this.activeTool) {
      this.textureAirbrushActiveNeighborPaintSeed = this.textureAirbrushNeighborSeedFromEvent?.(event, tool) || null;
      return this.textureAirbrushActiveNeighborPaintSeed;
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
      // Visibility is still enforced later by the airbrush projection shader;
      // do not use this pass gate to allow painting hidden faces.
      if (seed.component?.size) {
        return true;
      }
      if (Number.isInteger(seed.materialIndex) && (pass?.materialIndex ?? 0) !== seed.materialIndex) {
        return false;
      }
      return !seed.material || !pass?.material || pass.material === seed.material;
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
      if (!hasConnectedComponent && Number.isInteger(seed.materialIndex) && resolvedMaterialIndex !== seed.materialIndex) {
        return false;
      }
      const resolvedMaterial = material || (record && hit
        ? this.clonePaintMaterialForHit?.(record, hit) || null
        : null);
      if (!hasConnectedComponent && seed.material && resolvedMaterial && resolvedMaterial !== seed.material) {
        return false;
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
          return true;
        }
        for (const linkedIndex of this.textureAirbrushNeighborLinkedVertices(record, vertexIndex)) {
          if (seed.component.has(linkedIndex)) {
            return true;
          }
        }
      }
      return false;
    }
  });
}
