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
      const linked = typeof this.linkedSeamVertices === "function"
        ? this.linkedSeamVertices(record, vertexIndex)
        : null;
      return linked?.length ? linked : [vertexIndex];
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
      const resolvedMaterialIndex = Number.isInteger(materialIndex)
        ? materialIndex
        : hit?.face?.materialIndex ?? 0;
      if (Number.isInteger(seed.materialIndex) && resolvedMaterialIndex !== seed.materialIndex) {
        return false;
      }
      const resolvedMaterial = material || (record && hit
        ? this.clonePaintMaterialForHit?.(record, hit) || null
        : null);
      if (seed.material && resolvedMaterial && resolvedMaterial !== seed.material) {
        return false;
      }
      const hitNormal = normalizedNormal(hit?.face?.normal);
      if (seed.seedNormal && hitNormal) {
        const normalDot = seed.seedNormal.x * hitNormal.x
          + seed.seedNormal.y * hitNormal.y
          + seed.seedNormal.z * hitNormal.z;
        if (normalDot < 0) {
          return false;
        }
      }
      if (!seed.component?.size) {
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
