export function installClonePaintMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  function originalPositionVector(record, vertexIndex) {
    const offset = vertexIndex * 3;
    return new THREE.Vector3(
      record.originalPosition[offset],
      record.originalPosition[offset + 1],
      record.originalPosition[offset + 2]
    );
  }

  function currentPositionVector(record, vertexIndex) {
    return new THREE.Vector3().fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
  }

  function sourceImageSize(image) {
    return {
      width: image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width || 0,
      height: image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height || 0
    };
  }

  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function editableTextureCanvasSize(width, height) {
    const maxSide = Math.max(width, height);
    if (!maxSide) {
      return { width, height, scale: 1 };
    }
    const scale = Math.max(1, Math.min(4, Math.floor(2048 / maxSide)));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale
    };
  }

  Object.assign(BirdWeightEditor.prototype, {
    selectedCloneVertices(record) {
      return [...record.selected].filter((vertexIndex) => !record.deleted?.has(vertexIndex));
    },

    clonePaintFacesForVertices(record, vertices, minimumSelectedVertices = 3) {
      const selectedSet = vertices instanceof Set ? vertices : new Set(vertices || []);
      const position = record.geometry.attributes.position;
      const uv = record.geometry.attributes.uv;
      const index = record.geometry.index;
      const triangleCount = index ? index.count / 3 : Math.floor(position.count / 3);
      const faces = [];
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const triangleStart = triangle * 3;
        const triangleVertices = [
          index ? index.getX(triangleStart) : triangleStart,
          index ? index.getX(triangleStart + 1) : triangleStart + 1,
          index ? index.getX(triangleStart + 2) : triangleStart + 2
        ];
        const selectedCount = triangleVertices.reduce((count, vertexIndex) => (
          count + (selectedSet.has(vertexIndex) ? 1 : 0)
        ), 0);
        if (selectedCount < minimumSelectedVertices) {
          continue;
        }
        const centerUv = uv
          ? new THREE.Vector2(
            (uv.getX(triangleVertices[0]) + uv.getX(triangleVertices[1]) + uv.getX(triangleVertices[2])) / 3,
            (uv.getY(triangleVertices[0]) + uv.getY(triangleVertices[1]) + uv.getY(triangleVertices[2])) / 3
          )
          : null;
        faces.push({
          triangleStart,
          vertices: triangleVertices,
          a: triangleVertices[0],
          b: triangleVertices[1],
          c: triangleVertices[2],
          materialIndex: this.clonePaintTriangleMaterialIndex(record, triangleStart),
          centerUv
        });
      }
      return faces;
    },

    clonePaintDominantMaterialIndex(faces = []) {
      const counts = new Map();
      let best = 0;
      let bestCount = -1;
      for (const face of faces) {
        const materialIndex = Number.isInteger(face?.materialIndex) ? face.materialIndex : 0;
        const count = (counts.get(materialIndex) || 0) + 1;
        counts.set(materialIndex, count);
        if (count > bestCount) {
          best = materialIndex;
          bestCount = count;
        }
      }
      return best;
    },

    clonePaintUvCenterFromFaces(faces = [], materialIndex = null) {
      const center = new THREE.Vector2();
      let count = 0;
      for (const face of faces) {
        if (!face?.centerUv) {
          continue;
        }
        if (Number.isInteger(materialIndex) && face.materialIndex !== materialIndex) {
          continue;
        }
        center.add(face.centerUv);
        count += 1;
      }
      return count ? center.multiplyScalar(1 / count) : null;
    },

    clonePaintFaceOriginalCenter(record, face) {
      const center = new THREE.Vector3();
      for (const vertexIndex of face?.vertices || []) {
        center.add(originalPositionVector(record, vertexIndex));
      }
      return center.multiplyScalar(face?.vertices?.length ? 1 / face.vertices.length : 0);
    },

    clonePaintRepresentativeFace(record, faces = [], materialIndex = null) {
      const materialFaces = Number.isInteger(materialIndex)
        ? faces.filter((face) => face.materialIndex === materialIndex)
        : faces;
      const candidates = materialFaces.length ? materialFaces : faces;
      if (!candidates.length) {
        return null;
      }
      const center = new THREE.Vector3();
      const centers = candidates.map((face) => {
        const faceCenter = this.clonePaintFaceOriginalCenter(record, face);
        center.add(faceCenter);
        return { face, center: faceCenter };
      });
      center.multiplyScalar(1 / centers.length);
      let best = centers[0];
      let bestDistance = best.center.distanceToSquared(center);
      for (const entry of centers.slice(1)) {
        const distance = entry.center.distanceToSquared(center);
        if (distance < bestDistance) {
          best = entry;
          bestDistance = distance;
        }
      }
      return best.face;
    },

    clonePaintRegionFaceSnapshot(face) {
      return face
        ? {
          a: face.a,
          b: face.b,
          c: face.c,
          vertices: [...face.vertices],
          materialIndex: face.materialIndex,
          centerUv: face.centerUv?.clone?.() || null
        }
        : null;
    },

    clonePaintStampPixelInfo(data, pixel) {
      const offset = pixel * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      const saturation = max > 0 ? (max - min) / max : 0;
      return { r, g, b, a, luma, saturation };
    },

    clonePaintStampColorDistance(left, right) {
      const dr = left.r - right.r;
      const dg = left.g - right.g;
      const db = left.b - right.b;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    },

    clonePaintDominantStampCluster(data, pixelCount) {
      const candidates = [];
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const color = this.clonePaintStampPixelInfo(data, pixel);
        if (color.a < 24 || color.luma < 24 || color.saturation < 0.055) {
          continue;
        }
        candidates.push({ pixel, color });
      }
      if (candidates.length < 12) {
        for (let pixel = 0; pixel < pixelCount; pixel += 1) {
          const color = this.clonePaintStampPixelInfo(data, pixel);
          if (color.a >= 24 && color.luma >= 18) {
            candidates.push({ pixel, color });
          }
        }
      }
      if (!candidates.length) {
        return null;
      }

      const buckets = new Map();
      for (const candidate of candidates) {
        const key = [
          Math.round(candidate.color.r / 28),
          Math.round(candidate.color.g / 28),
          Math.round(candidate.color.b / 28)
        ].join(":");
        const bucket = buckets.get(key) || { candidates: [], score: 0 };
        bucket.candidates.push(candidate);
        bucket.score += 1 + candidate.color.saturation;
        buckets.set(key, bucket);
      }
      let best = null;
      for (const bucket of buckets.values()) {
        if (!best || bucket.score > best.score) {
          best = bucket;
        }
      }
      const center = best.candidates.reduce((sum, candidate) => {
        sum.r += candidate.color.r;
        sum.g += candidate.color.g;
        sum.b += candidate.color.b;
        return sum;
      }, { r: 0, g: 0, b: 0 });
      center.r /= best.candidates.length;
      center.g /= best.candidates.length;
      center.b /= best.candidates.length;

      let good = candidates.filter((candidate) => (
        this.clonePaintStampColorDistance(candidate.color, center) <= 86
        && candidate.color.luma >= 18
      ));
      if (good.length < Math.max(8, candidates.length * 0.18)) {
        good = candidates;
      }
      return { center, good };
    },

    clonePaintFillStampCanvas(canvas) {
      const context = canvas?.getContext?.("2d", { willReadFrequently: true });
      if (!canvas || !context) {
        return null;
      }
      const sourceImage = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixelCount = canvas.width * canvas.height;
      const cluster = this.clonePaintDominantStampCluster(sourceImage.data, pixelCount);
      if (!cluster?.good?.length) {
        return null;
      }

      let image = new ImageData(canvas.width, canvas.height);
      const average = cluster.good.reduce((sum, candidate) => {
        sum[0] += candidate.color.r;
        sum[1] += candidate.color.g;
        sum[2] += candidate.color.b;
        sum[3] += candidate.color.a;
        return sum;
      }, [0, 0, 0, 0]).map((value) => Math.round(value / cluster.good.length));

      for (const candidate of cluster.good) {
        const sourceOffset = candidate.pixel * 4;
        image.data[sourceOffset] = sourceImage.data[sourceOffset];
        image.data[sourceOffset + 1] = sourceImage.data[sourceOffset + 1];
        image.data[sourceOffset + 2] = sourceImage.data[sourceOffset + 2];
        image.data[sourceOffset + 3] = 255;
      }

      const isFilled = (index) => image.data[index * 4 + 3] > 0;

      for (let iteration = 0; iteration < canvas.width + canvas.height; iteration += 1) {
        const next = new Uint8ClampedArray(image.data);
        let changed = 0;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const pixel = y * canvas.width + x;
            if (isFilled(pixel)) {
              continue;
            }
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let count = 0;
            for (let oy = -1; oy <= 1; oy += 1) {
              for (let ox = -1; ox <= 1; ox += 1) {
                if (!ox && !oy) {
                  continue;
                }
                const sx = x + ox;
                const sy = y + oy;
                if (sx < 0 || sx >= canvas.width || sy < 0 || sy >= canvas.height) {
                  continue;
                }
                const sourcePixel = sy * canvas.width + sx;
                if (!isFilled(sourcePixel)) {
                  continue;
                }
                const offset = sourcePixel * 4;
                r += image.data[offset];
                g += image.data[offset + 1];
                b += image.data[offset + 2];
                a += image.data[offset + 3];
                count += 1;
              }
            }
            if (!count) {
              continue;
            }
            const offset = pixel * 4;
            next[offset] = Math.round(r / count);
            next[offset + 1] = Math.round(g / count);
            next[offset + 2] = Math.round(b / count);
            next[offset + 3] = Math.round(a / count);
            changed += 1;
          }
        }
        image = new ImageData(next, canvas.width, canvas.height);
        if (!changed) {
          break;
        }
      }

      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 4;
        if (image.data[offset + 3] > 0) {
          image.data[offset + 3] = 255;
          continue;
        }
        image.data[offset] = average[0];
        image.data[offset + 1] = average[1];
        image.data[offset + 2] = average[2];
        image.data[offset + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      return image;
    },

    clonePaintBuildSampleStamp(record, region, options = {}) {
      if (typeof document === "undefined") {
        return null;
      }
      const size = options.size || 96;
      const faces = this.clonePaintRegionFacesForMaterial(region, region?.originMaterialIndex ?? region?.materialIndex);
      if (!faces.length || !record?.geometry?.attributes?.uv) {
        return null;
      }
      const material = this.clonePaintMaterialForHit(record, {
        face: { materialIndex: region.originMaterialIndex ?? region.materialIndex ?? 0 }
      });
      const editable = this.editableClonePaintTexture(material);
      if (!editable) {
        return null;
      }
      const stampCanvas = document.createElement("canvas");
      stampCanvas.width = size;
      stampCanvas.height = size;
      const stampContext = stampCanvas.getContext("2d", { willReadFrequently: true });
      if (!stampContext) {
        return null;
      }
      stampContext.clearRect(0, 0, size, size);

      const { canvas: textureCanvas, texture } = editable;
      const previewPoints = this.clonePaintSurfacePreviewPoints(record, faces, stampCanvas);
      if (!previewPoints) {
        return null;
      }
      stampContext.imageSmoothingEnabled = true;
      for (const face of faces) {
        const targetPoints = face.vertices.map((vertexIndex) => previewPoints.get(vertexIndex));
        if (targetPoints.some((point) => !point)) {
          continue;
        }
        const sourcePoints = face.vertices.map((vertexIndex) => (
          this.clonePaintPixelFromUv(new THREE.Vector2(
            record.geometry.attributes.uv.getX(vertexIndex),
            record.geometry.attributes.uv.getY(vertexIndex)
          ), textureCanvas, texture)
        ));
        this.clonePaintDrawTexturedTriangle(stampContext, textureCanvas, sourcePoints, targetPoints);
      }
      const stampData = this.clonePaintFillStampCanvas(stampCanvas);
      if (!stampData) {
        return null;
      }
      return { canvas: stampCanvas, data: stampData };
    },

    clonePaintSampleStampPixel(stamp, x, y) {
      const canvas = stamp?.canvas;
      const data = stamp?.data?.data;
      if (!canvas || !data) {
        return null;
      }
      const wrap = (value, size) => {
        const rounded = Math.round(value);
        return ((rounded % size) + size) % size;
      };
      const sx = wrap(x, canvas.width);
      const sy = wrap(y, canvas.height);
      const offset = (sy * canvas.width + sx) * 4;
      return [
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3]
      ];
    },

    clonePaintTightVertices(record, vertices) {
      if ((vertices?.length || 0) < 3) {
        return vertices;
      }
      const fullFaces = this.clonePaintFacesForVertices(record, vertices, 3);
      const edgeFaces = fullFaces.length ? fullFaces : this.clonePaintFacesForVertices(record, vertices, 2);
      const paintFaces = edgeFaces.length ? edgeFaces : this.clonePaintFacesForVertices(record, vertices, 1);
      const tight = new Set();
      for (const face of paintFaces) {
        for (const vertexIndex of face.vertices) {
          tight.add(vertexIndex);
        }
      }
      return tight.size ? [...tight] : vertices;
    },

    cloneRegionCenter(record, vertices) {
      const center = new THREE.Vector3();
      for (const vertexIndex of vertices) {
        center.add(originalPositionVector(record, vertexIndex));
      }
      return center.multiplyScalar(vertices.length ? 1 / vertices.length : 0);
    },

    cloneRegionUvCenter(record, vertices) {
      const uv = record.geometry.attributes.uv;
      if (!uv) {
        return null;
      }
      const center = new THREE.Vector2();
      let count = 0;
      for (const vertexIndex of vertices) {
        if (vertexIndex < 0 || vertexIndex >= uv.count) {
          continue;
        }
        center.x += uv.getX(vertexIndex);
        center.y += uv.getY(vertexIndex);
        count += 1;
      }
      return count ? center.multiplyScalar(1 / count) : null;
    },

    clonePaintRegionFromVertices(record, vertices) {
      const tightVertices = this.clonePaintTightVertices(record, vertices);
      const faces = this.clonePaintFacesForVertices(record, tightVertices, 3);
      const materialIndex = this.clonePaintDominantMaterialIndex(faces);
      const representativeFace = this.clonePaintRepresentativeFace(record, faces, materialIndex);
      const uvCenter = representativeFace?.centerUv?.clone?.()
        || this.clonePaintUvCenterFromFaces(faces, materialIndex)
        || this.cloneRegionUvCenter(record, tightVertices);
      return {
        centerOriginal: this.cloneRegionCenter(record, tightVertices),
        uvCenter,
        originUv: uvCenter?.clone?.() || null,
        materialIndex,
        originMaterialIndex: materialIndex,
        faces,
        originFace: this.clonePaintRegionFaceSnapshot(representativeFace),
        samples: tightVertices.map((vertexIndex) => ({
          vertexIndex,
          original: originalPositionVector(record, vertexIndex),
          current: currentPositionVector(record, vertexIndex)
        })),
        vertices: new Set(tightVertices)
      };
    },

    captureClonePaintSource() {
      const records = new Map();
      let count = 0;

      for (const record of this.paintRecords || []) {
        const vertices = this.selectedCloneVertices(record);
        if (!vertices.length) {
          continue;
        }
        const region = this.clonePaintRegionFromVertices(record, vertices);
        region.stamp = this.clonePaintBuildSampleStamp(record, region);
        region.sourceFrame = this.clonePaintSourceScreenFrame?.(record, region, { freeze: true }) || null;
        records.set(record, region);
        count += region.vertices.size;
      }

      if (!count) {
        this.setStatus("Paint a sample selection first");
        return false;
      }

      this.clonePaintSource = { records, count };
      this.clonePaintTargets = new Map();
      for (const record of this.paintRecords || []) {
        record.selected.clear();
        this.updateRecordColors?.(record);
      }
      this.updateSelectionMarkers?.();
      this.updateMoveGizmo?.();
      this.updateCounts?.();
      this.syncClonePaintControls?.();
      this.updateCloneSpotlight?.();
      this.updateClonePaintPreviews?.();
      this.activateClonePaintTool?.({ sourceOnly: true, status: false });
      this.setStatus(`Clone texture sampled from ${count} ${count === 1 ? "vertex" : "vertices"}; brush to paint it`);
      return true;
    },

    captureClonePaintTarget() {
      if (!this.clonePaintSource?.count) {
        this.setStatus("Capture a clone sample first");
        return false;
      }

      let bestTarget = null;

      for (const record of this.paintRecords || []) {
        const source = this.clonePaintSource.records.get(record);
        if (!source) {
          continue;
        }
        const vertices = this.selectedCloneVertices(record);
        if (!vertices.length) {
          continue;
        }
        const region = this.clonePaintRegionFromVertices(record, vertices);
        region.offset = region.centerOriginal.clone().sub(source.centerOriginal);
        const count = region.vertices.size;
        if (!bestTarget || count > bestTarget.count) {
          bestTarget = { record, region, count };
        }
      }

      if (!bestTarget?.count) {
        this.setStatus("Paint a clone destination region on the same mesh");
        return false;
      }

      this.clonePaintTargets = new Map([[bestTarget.record, bestTarget.region]]);
      this.syncClonePaintControls?.();
      this.updateCloneSpotlight?.();
      this.updateClonePaintPreviews?.();
      this.setStatus(`Clone region captured from ${bestTarget.count} ${bestTarget.count === 1 ? "vertex" : "vertices"}`);
      return true;
    },

    refreshClonePaintTargetFromSelection(options = {}) {
      if (!this.clonePaintSource?.count || !this.clonePaintTargets?.size) {
        return 0;
      }

      let bestTarget = null;
      for (const record of this.paintRecords || []) {
        const source = this.clonePaintSource.records.get(record);
        if (!source) {
          continue;
        }
        const vertices = this.selectedCloneVertices(record);
        if (!vertices.length) {
          continue;
        }
        const region = this.clonePaintRegionFromVertices(record, vertices);
        region.offset = region.centerOriginal.clone().sub(source.centerOriginal);
        const count = region.vertices.size;
        if (!bestTarget || count > bestTarget.count) {
          bestTarget = { record, region, count };
        }
      }

      if (!bestTarget?.count) {
        this.clonePaintTargets = new Map();
        this.syncClonePaintControls?.();
        this.updateCloneSpotlight?.();
        this.updateClonePaintPreviews?.();
        if (options.status !== false) {
          this.setStatus("Clone region cleared");
        }
        return -1;
      }

      this.clonePaintTargets = new Map([[bestTarget.record, bestTarget.region]]);
      this.syncClonePaintControls?.();
      this.updateCloneSpotlight?.();
      this.updateClonePaintPreviews?.();
      if (options.status !== false) {
        this.setStatus(`Clone region refined to ${bestTarget.count} ${bestTarget.count === 1 ? "vertex" : "vertices"}`);
      }
      return bestTarget.count;
    },

    clearClonePaintState(options = {}) {
      this.clonePaintSource = null;
      this.clonePaintTargets = new Map();
      this.clearCloneSpotlight?.();
      this.updateClonePaintPreviews?.();
      this.syncClonePaintControls?.();
      if (!options.silent) {
        this.setStatus("Clone paint cleared");
      }
      return true;
    },

    clonePaintSurfacePreviewPoints(record, faces, canvas) {
      const position = record.geometry.attributes.position;
      if (!position || !this.camera) {
        return null;
      }
      this.camera.updateMatrixWorld?.(true);
      this.model?.updateMatrixWorld?.(true);
      record.object.updateMatrixWorld(true);

      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
      const rawPoints = [];
      const pointsByVertex = new Map();
      for (const face of faces) {
        for (const vertexIndex of face.vertices || []) {
          if (pointsByVertex.has(vertexIndex)) {
            continue;
          }
          const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform?.(record.object, vertexIndex, local);
          const world = local.clone();
          record.object.localToWorld(world);
          const point = {
            x: world.dot(right),
            y: -world.dot(up)
          };
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            continue;
          }
          pointsByVertex.set(vertexIndex, point);
          rawPoints.push(point);
        }
      }
      if (rawPoints.length < 3) {
        return null;
      }
      const minX = Math.min(...rawPoints.map((point) => point.x));
      const maxX = Math.max(...rawPoints.map((point) => point.x));
      const minY = Math.min(...rawPoints.map((point) => point.y));
      const maxY = Math.max(...rawPoints.map((point) => point.y));
      const spanX = Math.max(0.000001, maxX - minX);
      const spanY = Math.max(0.000001, maxY - minY);
      const margin = 7;
      const scale = Math.min(
        (canvas.width - margin * 2) / spanX,
        (canvas.height - margin * 2) / spanY
      );
      if (!Number.isFinite(scale) || scale <= 0) {
        return null;
      }
      const centerX = (minX + maxX) * 0.5;
      const centerY = (minY + maxY) * 0.5;
      const previewPoints = new Map();
      for (const [vertexIndex, point] of pointsByVertex) {
        previewPoints.set(vertexIndex, {
          x: canvas.width * 0.5 + (point.x - centerX) * scale,
          y: canvas.height * 0.5 + (point.y - centerY) * scale
        });
      }
      return previewPoints;
    },

    clonePaintTriangleTransform(sourcePoints, targetPoints) {
      const [sourceA, sourceB, sourceC] = sourcePoints;
      const [targetA, targetB, targetC] = targetPoints;
      const denominator = sourceA.x * (sourceB.y - sourceC.y)
        + sourceB.x * (sourceC.y - sourceA.y)
        + sourceC.x * (sourceA.y - sourceB.y);
      if (Math.abs(denominator) < 0.000001) {
        return null;
      }
      const a = (
        targetA.x * (sourceB.y - sourceC.y)
        + targetB.x * (sourceC.y - sourceA.y)
        + targetC.x * (sourceA.y - sourceB.y)
      ) / denominator;
      const b = (
        targetA.y * (sourceB.y - sourceC.y)
        + targetB.y * (sourceC.y - sourceA.y)
        + targetC.y * (sourceA.y - sourceB.y)
      ) / denominator;
      const c = (
        targetA.x * (sourceC.x - sourceB.x)
        + targetB.x * (sourceA.x - sourceC.x)
        + targetC.x * (sourceB.x - sourceA.x)
      ) / denominator;
      const d = (
        targetA.y * (sourceC.x - sourceB.x)
        + targetB.y * (sourceA.x - sourceC.x)
        + targetC.y * (sourceB.x - sourceA.x)
      ) / denominator;
      const e = (
        targetA.x * (sourceB.x * sourceC.y - sourceC.x * sourceB.y)
        + targetB.x * (sourceC.x * sourceA.y - sourceA.x * sourceC.y)
        + targetC.x * (sourceA.x * sourceB.y - sourceB.x * sourceA.y)
      ) / denominator;
      const f = (
        targetA.y * (sourceB.x * sourceC.y - sourceC.x * sourceB.y)
        + targetB.y * (sourceC.x * sourceA.y - sourceA.x * sourceC.y)
        + targetC.y * (sourceA.x * sourceB.y - sourceB.x * sourceA.y)
      ) / denominator;
      return { a, b, c, d, e, f };
    },

    clonePaintTransformPoint(transform, point) {
      return transform
        ? {
          x: transform.a * point.x + transform.c * point.y + transform.e,
          y: transform.b * point.x + transform.d * point.y + transform.f
        }
        : null;
    },

    clonePaintDrawTexturedTriangle(context, textureCanvas, sourcePoints, targetPoints) {
      const transform = this.clonePaintTriangleTransform(sourcePoints, targetPoints);
      if (!transform) {
        return null;
      }
      context.save();
      context.beginPath();
      targetPoints.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.closePath();
      context.clip();
      context.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
      context.drawImage(textureCanvas, 0, 0);
      context.restore();
      return transform;
    },

    clonePaintFaceMatches(left, right) {
      if (!left || !right?.vertices?.length) {
        return false;
      }
      const leftVertices = new Set(left.vertices || []);
      return right.vertices.every((vertexIndex) => leftVertices.has(vertexIndex));
    },

    clonePaintRegionFacesForMaterial(region, materialIndex = null) {
      const faces = region?.faces || [];
      if (!Number.isInteger(materialIndex)) {
        return faces.length ? faces : [];
      }
      const matching = faces.filter((face) => face.materialIndex === materialIndex);
      return matching.length ? matching : faces;
    },

    clonePaintFaceUvs(record, face) {
      const uv = record.geometry.attributes.uv;
      if (!uv || !face?.vertices?.length) {
        return [];
      }
      return face.vertices.map((vertexIndex) => new THREE.Vector2(
        uv.getX(vertexIndex),
        uv.getY(vertexIndex)
      ));
    },

    clonePaintFacePixels(record, face, canvas, texture, options = {}) {
      const referenceMapped = options.referenceUv
        ? this.clonePaintTextureUv(options.referenceUv, texture)
        : null;
      return this.clonePaintFaceUvs(record, face).map((uv) => {
        const mapped = this.clonePaintTextureUv(uv, texture);
        if (referenceMapped) {
          mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
          mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
          return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, { wrap: false });
        }
        return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture);
      });
    },

    clonePaintRegionTextureTriangles(record, region, materialIndex, canvas, texture, options = {}) {
      return this.clonePaintRegionFacesForMaterial(region, materialIndex)
        .map((face) => ({
          face,
          pixels: this.clonePaintFacePixels(record, face, canvas, texture, {
            referenceUv: options.referenceUv || region?.originUv || region?.uvCenter || face.centerUv
          })
        }))
        .filter((entry) => entry.pixels.length === 3 && entry.pixels.every((point) => (
          Number.isFinite(point.x) && Number.isFinite(point.y)
        )));
    },

    clonePaintPointInsideTextureTriangles(point, triangles, epsilon = 0.001) {
      return (triangles || []).some((triangle) => this.clonePaintBarycentricInside(
        this.clonePaintBarycentric(point, triangle.pixels),
        epsilon
      ));
    },

    clonePaintBarycentric(point, triangle) {
      const [a, b, c] = triangle || [];
      if (!a || !b || !c) {
        return null;
      }
      const v0x = b.x - a.x;
      const v0y = b.y - a.y;
      const v1x = c.x - a.x;
      const v1y = c.y - a.y;
      const v2x = point.x - a.x;
      const v2y = point.y - a.y;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const denominator = dot00 * dot11 - dot01 * dot01;
      if (Math.abs(denominator) < 0.000001) {
        return null;
      }
      const inv = 1 / denominator;
      const v = (dot11 * dot02 - dot01 * dot12) * inv;
      const w = (dot00 * dot12 - dot01 * dot02) * inv;
      const u = 1 - v - w;
      return { u, v, w };
    },

    clonePaintBarycentricInside(barycentric, epsilon = 0.001) {
      return Boolean(barycentric)
        && barycentric.u >= -epsilon
        && barycentric.v >= -epsilon
        && barycentric.w >= -epsilon
        && barycentric.u <= 1 + epsilon
        && barycentric.v <= 1 + epsilon
        && barycentric.w <= 1 + epsilon;
    },

    clonePaintInterpolatePoint(points, barycentric) {
      const [a, b, c] = points || [];
      if (!a || !b || !c || !barycentric) {
        return null;
      }
      return {
        x: a.x * barycentric.u + b.x * barycentric.v + c.x * barycentric.w,
        y: a.y * barycentric.u + b.y * barycentric.v + c.y * barycentric.w
      };
    },

    clonePaintInterpolateUv(record, face, barycentric) {
      const uvPoints = this.clonePaintFaceUvs(record, face);
      const point = this.clonePaintInterpolatePoint(uvPoints, barycentric);
      return point ? new THREE.Vector2(point.x, point.y) : null;
    },

    clonePaintRawSurfaceFrame(record, faces) {
      const position = record.geometry.attributes.position;
      if (!position || !this.camera || !faces?.length) {
        return null;
      }
      this.camera.updateMatrixWorld?.(true);
      this.model?.updateMatrixWorld?.(true);
      record.object.updateMatrixWorld(true);

      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
      const pointsByVertex = new Map();
      const rawPoints = [];
      for (const face of faces) {
        for (const vertexIndex of face.vertices || []) {
          if (pointsByVertex.has(vertexIndex)) {
            continue;
          }
          const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform?.(record.object, vertexIndex, local);
          const world = local.clone();
          record.object.localToWorld(world);
          const point = {
            x: world.dot(right),
            y: -world.dot(up)
          };
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            continue;
          }
          pointsByVertex.set(vertexIndex, point);
          rawPoints.push(point);
        }
      }
      if (rawPoints.length < 3) {
        return null;
      }
      const minX = Math.min(...rawPoints.map((point) => point.x));
      const maxX = Math.max(...rawPoints.map((point) => point.x));
      const minY = Math.min(...rawPoints.map((point) => point.y));
      const maxY = Math.max(...rawPoints.map((point) => point.y));
      return {
        pointsByVertex,
        minX,
        maxX,
        minY,
        maxY,
        spanX: Math.max(0.000001, maxX - minX),
        spanY: Math.max(0.000001, maxY - minY),
        center: {
          x: (minX + maxX) * 0.5,
          y: (minY + maxY) * 0.5
        }
      };
    },

    clonePaintFaceSurfacePoints(surfaceFrame, face) {
      return (face?.vertices || []).map((vertexIndex) => surfaceFrame?.pointsByVertex?.get(vertexIndex));
    },

    clonePaintSurfacePointForUv(record, face, uvPoint, surfaceFrame) {
      if (!face || !uvPoint || !surfaceFrame) {
        return null;
      }
      const uvPoints = this.clonePaintFaceUvs(record, face);
      const barycentric = this.clonePaintBarycentric(uvPoint, uvPoints) || { u: 1 / 3, v: 1 / 3, w: 1 / 3 };
      const surfacePoints = this.clonePaintFaceSurfacePoints(surfaceFrame, face);
      return this.clonePaintInterpolatePoint(surfacePoints, barycentric);
    },

    clonePaintRegionSurfaceFrame(record, region, faces) {
      const surfaceFrame = this.clonePaintRawSurfaceFrame(record, faces);
      if (!surfaceFrame) {
        return null;
      }
      const originFace = faces.find((face) => this.clonePaintFaceMatches(face, region?.originFace))
        || this.clonePaintRepresentativeFace(record, faces, region?.materialIndex)
        || faces[0];
      const originUv = region?.originUv || originFace?.centerUv || region?.uvCenter;
      const origin = this.clonePaintSurfacePointForUv(record, originFace, originUv, surfaceFrame)
        || this.clonePaintFaceOriginalCenter(record, originFace);
      return {
        ...surfaceFrame,
        origin: origin || surfaceFrame.center
      };
    },

    clonePaintSourceSampleForSurfacePoint(record, sourceFaces, sourceFrame, point) {
      if (!sourceFrame || !point) {
        return null;
      }
      for (const face of sourceFaces) {
        const surfacePoints = this.clonePaintFaceSurfacePoints(sourceFrame, face);
        if (surfacePoints.some((surfacePoint) => !surfacePoint)) {
          continue;
        }
        const barycentric = this.clonePaintBarycentric(point, surfacePoints);
        if (!this.clonePaintBarycentricInside(barycentric, 0.015)) {
          continue;
        }
        const uv = this.clonePaintInterpolateUv(record, face, barycentric);
        if (!uv) {
          continue;
        }
        return { face, uv };
      }
      return null;
    },

    drawClonePatchPreview(canvas, context, record, region) {
      const faces = (region?.faces || [])
        .filter((face) => Number.isInteger(face?.materialIndex)
          && face.materialIndex === (region.materialIndex ?? face.materialIndex));
      if (!faces.length || !record?.geometry?.attributes?.uv) {
        return false;
      }
      const material = this.clonePaintMaterialForHit(record, { face: { materialIndex: region.materialIndex || 0 } });
      const editable = this.editableClonePaintTexture(material);
      if (!editable) {
        return false;
      }
      this.refreshCloneSpotlightTextures?.(record);

      const { canvas: textureCanvas, texture } = editable;
      const previewPoints = this.clonePaintSurfacePreviewPoints(record, faces, canvas);
      if (!previewPoints) {
        return false;
      }

      context.imageSmoothingEnabled = true;
      let originPreviewPoint = null;
      for (const face of faces) {
        const targetPoints = face.vertices.map((vertexIndex) => previewPoints.get(vertexIndex));
        if (targetPoints.some((point) => !point)) {
          continue;
        }
        const sourcePoints = face.vertices.map((vertexIndex) => (
          this.clonePaintPixelFromUv(new THREE.Vector2(
            record.geometry.attributes.uv.getX(vertexIndex),
            record.geometry.attributes.uv.getY(vertexIndex)
          ), textureCanvas, texture)
        ));
        const transform = this.clonePaintDrawTexturedTriangle(context, textureCanvas, sourcePoints, targetPoints);
        if (transform && this.clonePaintFaceMatches(face, region.originFace) && (region.originUv || region.uvCenter)) {
          const originPixel = this.clonePaintPixelFromUv(region.originUv || region.uvCenter, textureCanvas, texture);
          originPreviewPoint = this.clonePaintTransformPoint(transform, originPixel);
        }
      }

      context.save();
      context.strokeStyle = "rgba(244, 234, 214, 0.62)";
      context.lineWidth = 1;
      for (const face of faces) {
        const targetPoints = face.vertices.map((vertexIndex) => previewPoints.get(vertexIndex));
        if (targetPoints.some((point) => !point)) {
          continue;
        }
        context.beginPath();
        targetPoints.forEach((point, index) => {
          if (index === 0) {
            context.moveTo(point.x, point.y);
          } else {
            context.lineTo(point.x, point.y);
          }
        });
        context.closePath();
        context.stroke();
      }
      if (originPreviewPoint) {
        context.strokeStyle = "rgba(255, 218, 111, 0.95)";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(originPreviewPoint.x - 5, originPreviewPoint.y);
        context.lineTo(originPreviewPoint.x + 5, originPreviewPoint.y);
        context.moveTo(originPreviewPoint.x, originPreviewPoint.y - 5);
        context.lineTo(originPreviewPoint.x, originPreviewPoint.y + 5);
        context.stroke();
      }
      context.restore();
      return true;
    },

    drawClonePreview(canvas, record, region) {
      const context = canvas?.getContext?.("2d");
      if (!canvas || !context) {
        return;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(0, 0, 0, 0.28)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (!record || !region?.uvCenter) {
        return;
      }
      if (region.stamp?.canvas) {
        context.imageSmoothingEnabled = true;
        context.drawImage(region.stamp.canvas, 0, 0, canvas.width, canvas.height);
        context.strokeStyle = "rgba(255, 255, 255, 0.92)";
        context.lineWidth = 2;
        context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
        return;
      }
      if (this.drawClonePatchPreview(canvas, context, record, region)) {
        context.strokeStyle = "rgba(255, 255, 255, 0.92)";
        context.lineWidth = 2;
        context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
        return;
      }
      const material = this.clonePaintMaterialForHit(record, {
        face: { materialIndex: region.originMaterialIndex ?? region.materialIndex ?? 0 }
      });
      const editable = this.editableClonePaintTexture(material);
      if (!editable) {
        return;
      }
      this.refreshCloneSpotlightTextures?.(record);
      const { canvas: textureCanvas, texture } = editable;
      const pixel = this.clonePaintPixelFromUv(region.originUv || region.uvCenter, textureCanvas, texture);
      const sampleSize = Math.max(24, Math.round(Number(this.brushRadius?.value || 0.035) * Math.max(textureCanvas.width, textureCanvas.height) * 2));
      const sx = Math.max(0, Math.min(textureCanvas.width - sampleSize, pixel.x - sampleSize / 2));
      const sy = Math.max(0, Math.min(textureCanvas.height - sampleSize, pixel.y - sampleSize / 2));
      context.imageSmoothingEnabled = false;
      context.drawImage(textureCanvas, sx, sy, sampleSize, sampleSize, 0, 0, canvas.width, canvas.height);
      context.strokeStyle = "rgba(255, 255, 255, 0.92)";
      context.lineWidth = 2;
      context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    },

    updateClonePaintPreviews() {
      const sourceEntry = this.clonePaintSource?.records?.entries?.().next?.().value || null;
      this.drawClonePreview(this.cloneSourcePreview, sourceEntry?.[0], sourceEntry?.[1]);
      const targetEntry = this.clonePaintTargets?.entries?.().next?.().value || null;
      this.drawClonePreview(this.cloneRegionPreview, targetEntry?.[0], targetEntry?.[1]);
    },

    cloneSpotlightVertices(source = null, target = null) {
      const verticesByRecord = new Map();
      const add = (record, vertices, kind) => {
        if (!record || !vertices?.size) {
          return;
        }
        const entry = verticesByRecord.get(record) || { source: new Set(), target: new Set() };
        for (const vertexIndex of vertices) {
          entry[kind].add(vertexIndex);
        }
        verticesByRecord.set(record, entry);
      };
      for (const [record, region] of source?.records || []) {
        add(record, region.vertices, "source");
      }
      for (const [record, region] of target || []) {
        add(record, region.vertices, "target");
      }
      return verticesByRecord;
    },

    clonePaintTriangleMaterialIndex(record, triangleStart) {
      const group = (record.geometry.groups || []).find((entry) => (
        triangleStart >= entry.start
        && triangleStart < entry.start + entry.count
      ));
      return group?.materialIndex || 0;
    },

    buildCloneSpotlightGeometry(record, vertices) {
      const position = record.geometry.attributes.position;
      const uv = record.geometry.attributes.uv;
      const normal = record.geometry.attributes.normal;
      const skinIndex = record.geometry.attributes.skinIndex;
      const skinWeight = record.geometry.attributes.skinWeight;
      const index = record.geometry.index;
      const vertexSet = vertices || new Set();
      const points = [];
      const uvs = [];
      const normals = [];
      const skinIndices = [];
      const skinWeights = [];
      const groups = [];
      const triangleCount = index ? index.count / 3 : Math.floor(position.count / 3);
      const appendTriangle = (triangleStart, triangleVertices) => {
        groups.push({
          start: points.length / 3,
          count: 3,
          materialIndex: this.clonePaintTriangleMaterialIndex(record, triangleStart)
        });
        for (const vertexIndex of triangleVertices) {
          points.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
          if (uv) {
            uvs.push(uv.getX(vertexIndex), uv.getY(vertexIndex));
          }
          if (normal) {
            normals.push(normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex));
          }
          if (skinIndex && skinWeight) {
            skinIndices.push(
              skinIndex.getX(vertexIndex),
              skinIndex.getY(vertexIndex),
              skinIndex.getZ(vertexIndex),
              skinIndex.getW(vertexIndex)
            );
            skinWeights.push(
              skinWeight.getX(vertexIndex),
              skinWeight.getY(vertexIndex),
              skinWeight.getZ(vertexIndex),
              skinWeight.getW(vertexIndex)
            );
          }
        }
      };
      const appendTriangles = (minimumSelectedVertices) => {
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const triangleStart = triangle * 3;
          const triangleVertices = [
            index ? index.getX(triangleStart) : triangleStart,
            index ? index.getX(triangleStart + 1) : triangleStart + 1,
            index ? index.getX(triangleStart + 2) : triangleStart + 2
          ];
          const selectedCount = triangleVertices.reduce((count, vertexIndex) => (
            count + (vertexSet.has(vertexIndex) ? 1 : 0)
          ), 0);
          if (selectedCount < minimumSelectedVertices) {
            continue;
          }
          appendTriangle(triangleStart, triangleVertices);
        }
      };
      appendTriangles(3);
      if (!points.length) {
        return null;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      if (uvs.length) {
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      }
      if (normals.length) {
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      } else {
        geometry.computeVertexNormals();
      }
      if (skinIndices.length && skinWeights.length) {
        geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
        geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
      }
      for (const group of groups) {
        geometry.addGroup(group.start, group.count, group.materialIndex);
      }
      geometry.computeBoundingSphere();
      return geometry;
    },

    cloneSpotlightMaterialSet(record) {
      const materials = this.getObjectMaterials(record.object.material).map((material) => {
        const overlayMaterial = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          map: material?.map || null,
          alphaMap: material?.alphaMap || null,
          transparent: Boolean(material?.transparent),
          opacity: 1,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2
        });
        overlayMaterial.fog = false;
        overlayMaterial.toneMapped = false;
        overlayMaterial.userData.cloneSpotlightMaterial = true;
        return overlayMaterial;
      });
      return materials.length > 1 ? materials : materials[0] || new THREE.MeshBasicMaterial({ color: 0xffffff });
    },

    setCloneBaseTextureDimmed(enabled) {
      this.cloneSpotlightActive = enabled;
      for (const record of this.paintRecords || []) {
        for (const material of this.getObjectMaterials(record.object.material)) {
          if (!material) {
            continue;
          }
          material.color.copy(material.userData?.editorBaseColor || new THREE.Color(0xffffff));
          material.color.multiplyScalar(enabled ? 0.08 : this.textureGain ?? 1);
          material.opacity = enabled ? 0.04 : Number.isFinite(material.userData?.editorBaseOpacity) ? material.userData.editorBaseOpacity : 1;
          material.transparent = enabled || Boolean(material.userData?.editorWasTransparent);
          material.depthWrite = !enabled;
          material.needsUpdate = true;
        }
      }
    },

    clearCloneSpotlight() {
      for (const overlay of this.cloneSpotlightOverlays || []) {
        overlay.parent?.remove(overlay);
        overlay.geometry?.dispose?.();
        const materials = Array.isArray(overlay.material) ? overlay.material : [overlay.material];
        for (const material of materials) {
          if (material?.userData?.cloneSpotlightMaterial) {
            material.dispose?.();
          }
        }
      }
      this.cloneSpotlightOverlays = [];
      this.setCloneBaseTextureDimmed(false);
      this.updateMeshWireOverlays?.();
      this.updateSelectionMarkers?.();
      this.updateSelectedBoneHighlight?.();
      this.updateBoneLabels?.();
    },

    updateCloneSpotlight() {
      this.clearCloneSpotlight();
      const regions = this.cloneSpotlightVertices(this.clonePaintSource, this.clonePaintTargets);
      if (!regions.size) {
        return;
      }
      const shouldIsolate = Boolean(this.clonePaintTargets?.size);
      this.setCloneBaseTextureDimmed(shouldIsolate);
      if (shouldIsolate && this.selectionMarkers) {
        this.selectionMarkers.visible = false;
      }
      this.updateMeshWireOverlays?.();
      this.updateSelectedBoneHighlight?.();
      this.updateBoneLabels?.();
      for (const [record, entry] of regions) {
        for (const [kind, vertices] of [["source", entry.source], ["target", entry.target]]) {
          if (shouldIsolate && kind === "source") {
            continue;
          }
          const geometry = this.buildCloneSpotlightGeometry(record, vertices);
          if (!geometry) {
            continue;
          }
          const material = this.cloneSpotlightMaterialSet(record);
          const overlay = record.object.isSkinnedMesh && record.object.skeleton
            ? new THREE.SkinnedMesh(geometry, material)
            : new THREE.Mesh(geometry, material);
          overlay.name = `clone ${kind} spotlight`;
          overlay.userData.sourceObject = record.object;
          overlay.userData.cloneSpotlightKind = kind;
          overlay.userData.cloneSpotlightRecord = record;
          overlay.frustumCulled = false;
          overlay.renderOrder = kind === "source" ? 42 : 43;
          overlay.userData.mixamoCleanupHelper = "clone-spotlight";
          if (overlay.isSkinnedMesh) {
            overlay.bindMode = record.object.bindMode;
            overlay.bind(record.object.skeleton, record.object.bindMatrix);
          }
          record.object.updateMatrixWorld(true);
          record.object.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
          overlay.updateMatrixWorld(true);
          this.scene.add(overlay);
          this.cloneSpotlightOverlays.push(overlay);
        }
      }
    },

    updateCloneSpotlightTransforms() {
      for (const overlay of this.cloneSpotlightOverlays || []) {
        const sourceObject = overlay.userData?.sourceObject;
        if (!sourceObject) {
          continue;
        }
        sourceObject.updateMatrixWorld(true);
        sourceObject.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
        overlay.updateMatrixWorld(true);
      }
    },

    refreshCloneSpotlightTextures(record = null) {
      for (const overlay of this.cloneSpotlightOverlays || []) {
        const sourceObject = overlay.userData?.sourceObject;
        if (!sourceObject || (record && sourceObject !== record.object)) {
          continue;
        }
        const sourceMaterials = this.getObjectMaterials(sourceObject.material);
        const overlayMaterials = Array.isArray(overlay.material) ? overlay.material : [overlay.material];
        for (let index = 0; index < overlayMaterials.length; index += 1) {
          const overlayMaterial = overlayMaterials[index];
          const sourceMaterial = sourceMaterials[index] || sourceMaterials.find((material) => material?.map) || sourceMaterials[0];
          if (!overlayMaterial || !sourceMaterial) {
            continue;
          }
          overlayMaterial.map = sourceMaterial.map || null;
          overlayMaterial.alphaMap = sourceMaterial.alphaMap || null;
          overlayMaterial.transparent = Boolean(sourceMaterial.transparent || sourceMaterial.alphaMap);
          overlayMaterial.needsUpdate = true;
        }
      }
    },

    clonePaintStatusText() {
      const sourceCount = this.clonePaintSource?.count || 0;
      const targetCount = [...(this.clonePaintTargets?.values?.() || [])]
        .reduce((sum, target) => sum + target.vertices.size, 0);
      if (this.activeTool === "clone" && sourceCount && targetCount) {
        return `Stamp active: ${sourceCount} source / ${targetCount} region`;
      }
      if (this.activeTool === "clone" && sourceCount) {
        return `Clone brush active: ${sourceCount} sample`;
      }
      if (!sourceCount) {
        return "Clone: no sample";
      }
      if (!targetCount) {
        return `Clone: ${sourceCount} sample`;
      }
      return `Clone: ${sourceCount} source / ${targetCount} region`;
    },

    syncClonePaintControls() {
      const selected = (this.paintRecords || []).some((record) => this.selectedCloneVertices(record).length > 0);
      const hasSource = Boolean(this.clonePaintSource?.count);
      const hasTarget = Boolean(this.clonePaintTargets?.size);
      if (this.clonePaintSourceButton) {
        this.clonePaintSourceButton.disabled = !this.model || !selected;
      }
      if (this.clonePaintTargetButton) {
        this.clonePaintTargetButton.disabled = !this.model || !hasSource || !selected;
      }
      if (this.clonePaintToolButton) {
        this.clonePaintToolButton.disabled = !this.model || !hasSource;
        this.clonePaintToolButton.classList.toggle("is-active", this.activeTool === "clone");
        this.clonePaintToolButton.setAttribute("aria-pressed", String(this.activeTool === "clone"));
      }
      if (this.clonePaintClearButton) {
        this.clonePaintClearButton.disabled = !hasSource && !hasTarget;
      }
      if (this.clonePaintCopyJsonButton) {
        this.clonePaintCopyJsonButton.disabled = !this.model;
      }
      if (this.textureFillRegionButton) {
        this.textureFillRegionButton.disabled = !this.model || !hasTarget;
      }
      if (this.clonePaintStatus) {
        this.clonePaintStatus.textContent = this.clonePaintStatusText();
      }
    },

    activateClonePaintTool(options = {}) {
      const hasSource = Boolean(this.clonePaintSource?.count);
      const hasTarget = Boolean(this.clonePaintTargets?.size);
      if (!hasSource) {
        this.setStatus("Capture a clone sample first");
        this.syncClonePaintControls?.();
        return false;
      }
      this.neighborStroke = null;
      this.painting = false;
      this.selectionStrokeUndo = null;
      if (this.neighborHoverMarker) {
        this.neighborHoverMarker.visible = false;
      }
      if (this.viewMode === "edit") {
        this.setViewMode("both", { silent: true });
      }
      this.setTool("clone");
      this.controls.enabled = false;
      this.syncClonePaintControls?.();
      this.updateCloneSpotlight?.();
      this.updateClonePaintPreviews?.();
      const stamped = options.stamp === true
        ? this.stampClonePaintTargets?.({ status: false }) || 0
        : 0;
      if (!hasTarget) {
        if (options.status !== false) {
          this.setStatus("Clone brush armed; paint the sampled texture onto the model");
        }
        return true;
      }
      const targetOverlayCount = (this.cloneSpotlightOverlays || []).filter((overlay) => (
        overlay.userData?.cloneSpotlightKind === "target"
        && overlay.geometry?.attributes?.position?.count >= 3
      )).length;
      if (!targetOverlayCount) {
        this.setStatus("Clone region has no paintable texture faces");
        return true;
      }
      this.setStatus(stamped > 0
        ? `Clone swatch applied to ${stamped} ${stamped === 1 ? "pixel" : "pixels"}`
        : "Clone swatch armed; airbrush inside the region");
      return true;
    },

    clonePaintMaterialForHit(record, hit) {
      const materials = Array.isArray(record.object.material)
        ? record.object.material
        : [record.object.material].filter(Boolean);
      if (!materials.length) {
        return null;
      }
      const materialIndex = Number.isInteger(hit?.face?.materialIndex)
        ? hit.face.materialIndex
        : 0;
      return materials[materialIndex] || materials.find((material) => material?.map) || materials[0];
    },

    editableClonePaintTexture(material) {
      if (!material) {
        return null;
      }
      material.userData ||= {};
      if (material.userData?.clonePaintCanvas && material.userData?.clonePaintContext && material.userData?.clonePaintTexture === material.map) {
        return {
          canvas: material.userData.clonePaintCanvas,
          context: material.userData.clonePaintContext,
          texture: material.map
        };
      }

      const sourceMap = material.map || null;
      if (!Object.prototype.hasOwnProperty.call(material.userData, "clonePaintOriginalMap")) {
        material.userData.clonePaintOriginalMap = sourceMap;
      }
      const image = sourceMap?.image || null;
      const { width, height } = sourceImageSize(image);
      const hasSourceImage = Boolean(width && height);
      if (typeof document === "undefined") {
        return null;
      }
      const canvasSize = hasSourceImage
        ? editableTextureCanvasSize(width, height)
        : { width: 512, height: 512, scale: 1 };

      const canvas = document.createElement("canvas");
      canvas.width = canvasSize.width;
      canvas.height = canvasSize.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }
      try {
        context.imageSmoothingEnabled = true;
        if (hasSourceImage) {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
        } else {
          const color = material.color || new THREE.Color(1, 1, 1);
          context.fillStyle = `rgb(${clampByte(color.r * 255)}, ${clampByte(color.g * 255)}, ${clampByte(color.b * 255)})`;
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      } catch (error) {
        console.warn("Could not prepare editable texture for clone paint", error);
        return null;
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.name = sourceMap?.name || "clone paint material color texture";
      texture.colorSpace = sourceMap?.colorSpace || THREE.SRGBColorSpace;
      texture.flipY = sourceMap?.flipY ?? false;
      texture.wrapS = sourceMap?.wrapS || THREE.ClampToEdgeWrapping;
      texture.wrapT = sourceMap?.wrapT || THREE.ClampToEdgeWrapping;
      texture.magFilter = sourceMap?.magFilter || THREE.LinearFilter;
      texture.minFilter = sourceMap?.minFilter || THREE.LinearFilter;
      texture.generateMipmaps = sourceMap?.generateMipmaps ?? true;
      if (sourceMap?.offset) {
        texture.offset.copy(sourceMap.offset);
      }
      if (sourceMap?.repeat) {
        texture.repeat.copy(sourceMap.repeat);
      }
      if (sourceMap?.center) {
        texture.center.copy(sourceMap.center);
      }
      texture.rotation = sourceMap?.rotation || 0;
      texture.matrixAutoUpdate = sourceMap?.matrixAutoUpdate ?? true;
      if (sourceMap?.matrix) {
        texture.matrix.copy(sourceMap.matrix);
      }
      texture.needsUpdate = true;

      material.map = texture;
      material.needsUpdate = true;
      material.userData.clonePaintCanvas = canvas;
      material.userData.clonePaintContext = context;
      material.userData.clonePaintTexture = texture;
      material.userData.clonePaintTextureScale = canvasSize.scale;
      return { canvas, context, texture };
    },

    resetEditableTexturePaintMaterial(material) {
      if (!material?.userData) {
        return false;
      }
      const userData = material.userData;
      let changed = false;
      const gpuEntry = userData.textureAirbrushGpuTarget;
      if (gpuEntry?.target) {
        if (material.map === gpuEntry.target.texture) {
          material.map = gpuEntry.sourceTexture || userData.clonePaintTexture || userData.clonePaintOriginalMap || null;
        }
        gpuEntry.target.dispose?.();
        delete userData.textureAirbrushGpuTarget;
        changed = true;
      }

      const hasOriginalMap = Object.prototype.hasOwnProperty.call(userData, "clonePaintOriginalMap");
      const cloneTexture = userData.clonePaintTexture;
      const hasClonePaint = Boolean(userData.clonePaintCanvas || userData.clonePaintContext || cloneTexture || hasOriginalMap);
      if (hasClonePaint) {
        const originalMap = hasOriginalMap ? userData.clonePaintOriginalMap : null;
        if (!material.map || material.map === cloneTexture || material.map === gpuEntry?.sourceTexture) {
          material.map = originalMap || null;
        }
        if (cloneTexture && cloneTexture !== originalMap && cloneTexture !== material.map) {
          cloneTexture.dispose?.();
        }
        delete userData.clonePaintCanvas;
        delete userData.clonePaintContext;
        delete userData.clonePaintTexture;
        delete userData.clonePaintTextureScale;
        delete userData.clonePaintOriginalMap;
        changed = true;
      }

      if (changed) {
        material.needsUpdate = true;
      }
      return changed;
    },

    resetEditableTexturePaints({ sync = true } = {}) {
      const seen = new Set();
      let reset = 0;
      for (const record of this.paintRecords || []) {
        for (const material of this.getObjectMaterials?.(record.object?.material) || []) {
          if (!material || seen.has(material)) {
            continue;
          }
          seen.add(material);
          if (this.resetEditableTexturePaintMaterial(material)) {
            reset += 1;
          }
        }
      }
      if (!reset) {
        return 0;
      }
      this.textureAirbrushGpuProxies?.clear?.();
      this.updateClonePaintPreviews?.();
      if (sync) {
        this.syncPatchJson?.();
      }
      return reset;
    },

    clonePaintTextureUv(uv, texture) {
      const mapped = uv?.clone?.() || new THREE.Vector2();
      if (texture) {
        if (texture.matrixAutoUpdate && typeof texture.updateMatrix === "function") {
          texture.updateMatrix();
        }
        if (texture.matrix) {
          mapped.applyMatrix3(texture.matrix);
        }
      }
      return mapped;
    },

    clonePaintWrapUvCoordinate(value, wrapMode) {
      if (wrapMode === THREE.MirroredRepeatWrapping) {
        const wrapped = THREE.MathUtils.euclideanModulo(value, 2);
        return wrapped > 1 ? 2 - wrapped : wrapped;
      }
      if (wrapMode === THREE.RepeatWrapping) {
        return THREE.MathUtils.euclideanModulo(value, 1);
      }
      return Math.max(0, Math.min(1, value));
    },

    clonePaintUnwrapTextureCoordinate(value, reference, wrapMode) {
      if (!Number.isFinite(reference)) {
        return value;
      }
      if (wrapMode === THREE.MirroredRepeatWrapping) {
        return value + Math.round((reference - value) / 2) * 2;
      }
      if (wrapMode === THREE.RepeatWrapping) {
        return value + Math.round(reference - value);
      }
      return value;
    },

    clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, options = {}) {
      const shouldWrap = options.wrap !== false;
      const u = shouldWrap ? this.clonePaintWrapUvCoordinate(mapped.x, texture?.wrapS) : mapped.x;
      const v = shouldWrap ? this.clonePaintWrapUvCoordinate(mapped.y, texture?.wrapT) : mapped.y;
      const x = Math.round(u * (canvas.width - 1));
      const y = Math.round((texture?.flipY ? 1 - v : v) * (canvas.height - 1));
      if (!shouldWrap) {
        return { x, y };
      }
      return {
        x: Math.max(0, Math.min(canvas.width - 1, x)),
        y: Math.max(0, Math.min(canvas.height - 1, y))
      };
    },

    clonePaintPixelFromUv(uv, canvas, texture, options = {}) {
      return this.clonePaintPixelFromMappedTextureUv(
        this.clonePaintTextureUv(uv, texture),
        canvas,
        texture,
        options
      );
    },

    clonePaintMappedTextureUvFromPixel(point, canvas, texture) {
      const u = canvas.width > 1 ? point.x / (canvas.width - 1) : 0;
      const rawV = canvas.height > 1 ? point.y / (canvas.height - 1) : 0;
      return new THREE.Vector2(u, texture?.flipY ? 1 - rawV : rawV);
    },

    clonePaintActualPixelFromTexturePoint(point, canvas, texture) {
      return this.clonePaintPixelFromMappedTextureUv(
        this.clonePaintMappedTextureUvFromPixel(point, canvas, texture),
        canvas,
        texture
      );
    },

    clonePaintUvFromPixel(x, y, canvas, texture) {
      const mapped = this.clonePaintMappedTextureUvFromPixel({ x, y }, canvas, texture);
      if (!texture?.matrix) {
        return mapped;
      }
      if (texture.matrixAutoUpdate && typeof texture.updateMatrix === "function") {
        texture.updateMatrix();
      }
      return mapped.applyMatrix3(new THREE.Matrix3().copy(texture.matrix).invert());
    },

    clonePaintUvDistanceSq(a, b) {
      if (!a || !b) {
        return Number.POSITIVE_INFINITY;
      }
      const dx = Math.min(Math.abs(a.x - b.x), 1 - Math.abs(a.x - b.x));
      const dy = Math.min(Math.abs(a.y - b.y), 1 - Math.abs(a.y - b.y));
      return dx * dx + dy * dy;
    },

    clonePaintHitTargetScore(record, hit, target) {
      let score = hit.distance || 0;
      const targetVertices = target?.vertices || new Set();
      if (hit.face && targetVertices.size) {
        const faceVertices = [hit.face.a, hit.face.b, hit.face.c];
        const expandedTarget = typeof this.topologyExpandedVertices === "function"
          ? this.topologyExpandedVertices(record, targetVertices, 2)
          : targetVertices;
        if (faceVertices.some((vertexIndex) => targetVertices.has(vertexIndex))) {
          score -= 100000;
        } else if (faceVertices.some((vertexIndex) => expandedTarget.has(vertexIndex))) {
          score -= 50000;
        }
      }
      if (target?.uvCenter && hit.uv) {
        score += this.clonePaintUvDistanceSq(hit.uv, target.uvCenter) * 1000;
      }
      return score;
    },

    clonePaintProxySpotlightHit(hit, record, target = null) {
      return {
        ...hit,
        object: record.object,
        face: {
          ...(hit.face || {}),
          materialIndex: Number.isInteger(hit.face?.materialIndex)
            ? hit.face.materialIndex
            : target?.originMaterialIndex ?? target?.materialIndex ?? 0
        },
        cloneRegionHit: true
      };
    },

    texturePaintHitFromIntersections(intersections = []) {
      let firstMeshHit = null;
      const textureRecords = this.textureAirbrushRecords?.() || this.paintRecords || [];
      for (const hit of intersections) {
        const spotlightKind = hit.object?.userData?.cloneSpotlightKind;
        const spotlightRecord = hit.object?.userData?.cloneSpotlightRecord;
        if (spotlightRecord) {
          if (spotlightKind !== "target") {
            continue;
          }
          const target = this.clonePaintTargets?.get(spotlightRecord);
          return {
            record: spotlightRecord,
            hit: this.clonePaintProxySpotlightHit(hit, spotlightRecord, target)
          };
        }
        if (!firstMeshHit) {
          const record = textureRecords.find((item) => item.object === hit.object);
          if (record) {
            firstMeshHit = { record, hit };
          }
        }
      }
      return firstMeshHit;
    },

    texturePaintOverlayMaterialIndex(geometry, triangleStart) {
      const group = (geometry?.groups || []).find((entry) => (
        triangleStart >= entry.start
        && triangleStart < entry.start + entry.count
      ));
      return group?.materialIndex || 0;
    },

    texturePaintClosestTrianglePoint(point, triangle) {
      const [a, b, c] = triangle || [];
      if (!a || !b || !c || !point) {
        return null;
      }
      const closestOnSegment = (start, end) => {
        const vx = end.x - start.x;
        const vy = end.y - start.y;
        const wx = point.x - start.x;
        const wy = point.y - start.y;
        const lengthSq = vx * vx + vy * vy || 0.000001;
        const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSq));
        return {
          x: start.x + vx * t,
          y: start.y + vy * t
        };
      };
      const barycentric = this.clonePaintBarycentric(point, triangle);
      if (this.clonePaintBarycentricInside(barycentric, 0.035)) {
        return { point, barycentric, distanceSq: 0 };
      }
      const candidates = [
        closestOnSegment(a, b),
        closestOnSegment(b, c),
        closestOnSegment(c, a)
      ];
      let bestPoint = candidates[0];
      let bestDistanceSq = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const dx = point.x - candidate.x;
        const dy = point.y - candidate.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestPoint = candidate;
        }
      }
      return {
        point: bestPoint,
        barycentric: this.clonePaintBarycentric(bestPoint, triangle),
        distanceSq: bestDistanceSq
      };
    },

    texturePaintScreenSpotlightHit(event) {
      if (!event || !this.canvas || !this.camera) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = typeof this.textureBrushRadiusScreenPixels === "function"
        ? this.textureBrushRadiusScreenPixels()
        : Math.max(6, Number(this.brushRadius?.value || 0.035) * 720);
      const maxDistanceSq = brushRadius * brushRadius;
      let best = null;
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (!overlay?.visible || overlay.userData?.cloneSpotlightKind !== "target") {
          continue;
        }
        const record = overlay.userData?.cloneSpotlightRecord;
        const target = record ? this.clonePaintTargets?.get(record) : null;
        const geometry = overlay.geometry;
        const position = geometry?.attributes?.position;
        const uv = geometry?.attributes?.uv;
        if (!record || !target?.vertices?.size || !position || !uv) {
          continue;
        }
        overlay.updateMatrixWorld(true);
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const start = triangle * 3;
          const screenPoints = [];
          const worldPoints = [];
          const uvPoints = [];
          let clipped = false;
          for (let offset = 0; offset < 3; offset += 1) {
            const vertexIndex = start + offset;
            const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
            this.applyBoneTransform?.(overlay, vertexIndex, local);
            const world = local.clone();
            overlay.localToWorld(world);
            const projected = world.clone().project(this.camera);
            if (projected.z < -1 || projected.z > 1) {
              clipped = true;
              break;
            }
            screenPoints.push({
              x: (projected.x * 0.5 + 0.5) * rect.width,
              y: (-projected.y * 0.5 + 0.5) * rect.height,
              z: projected.z
            });
            worldPoints.push(world);
            uvPoints.push(new THREE.Vector2(
              uv.getX(vertexIndex),
              uv.getY(vertexIndex)
            ));
          }
          if (clipped) {
            continue;
          }
          const closest = this.texturePaintClosestTrianglePoint(pointer, screenPoints);
          if (!closest?.barycentric || closest.distanceSq > maxDistanceSq) {
            continue;
          }
          const barycentric = closest.barycentric;
          const hitUv = new THREE.Vector2(
            uvPoints[0].x * barycentric.u + uvPoints[1].x * barycentric.v + uvPoints[2].x * barycentric.w,
            uvPoints[0].y * barycentric.u + uvPoints[1].y * barycentric.v + uvPoints[2].y * barycentric.w
          );
          const worldPoint = new THREE.Vector3()
            .addScaledVector(worldPoints[0], barycentric.u)
            .addScaledVector(worldPoints[1], barycentric.v)
            .addScaledVector(worldPoints[2], barycentric.w);
          const depthScore = (screenPoints[0].z + screenPoints[1].z + screenPoints[2].z) / 3;
          const score = closest.distanceSq * 100 + depthScore;
          if (best && score >= best.score) {
            continue;
          }
          best = {
            record,
            hit: this.clonePaintProxySpotlightHit({
              object: overlay,
              point: worldPoint,
              uv: hitUv,
              distance: score,
              screenPoint: {
                x: closest.point.x,
                y: closest.point.y
              },
              face: {
                a: start,
                b: start + 1,
                c: start + 2,
                materialIndex: this.texturePaintOverlayMaterialIndex(geometry, start)
              }
            }, record, target),
            score
          };
        }
      }
      return best ? { record: best.record, hit: best.hit } : null;
    },

    clonePaintHitFromIntersections(intersections = []) {
      let best = null;
      for (const hit of intersections) {
        const spotlightKind = hit.object?.userData?.cloneSpotlightKind;
        const spotlightRecord = hit.object?.userData?.cloneSpotlightRecord;
        const record = spotlightRecord || this.paintRecords.find((item) => item.object === hit.object);
        if (!record) {
          continue;
        }
        const source = this.clonePaintSource?.records?.get(record);
        const target = this.clonePaintTargets?.get(record);
        if (!source) {
          continue;
        }
        if (!target?.vertices?.size) {
          if (spotlightRecord) {
            continue;
          }
          const score = hit.distance || 0;
          if (!best || score < best.score) {
            best = { record, hit, score };
          }
          continue;
        }
        if (spotlightRecord) {
          if (spotlightKind !== "target") {
            continue;
          }
          const proxyHit = this.clonePaintProxySpotlightHit(hit, record, target);
          return { record, hit: proxyHit, score: Number.NEGATIVE_INFINITY };
        }
        const score = this.clonePaintHitTargetScore(record, hit, target);
        if (!best || score < best.score) {
          best = { record, hit, score };
        }
      }
      return best;
    },

    clonePaintHitInsideRegion(hit, target) {
      if (hit?.cloneRegionHit) {
        return true;
      }
      if (!hit?.face || !target?.vertices?.size) {
        return false;
      }
      return [hit.face.a, hit.face.b, hit.face.c].some((vertexIndex) => target.vertices.has(vertexIndex));
    },

    clonePaintFaceForTarget(record, target) {
      const vertices = [...(target?.vertices || [])];
      const index = record.geometry.index;
      const position = record.geometry.attributes.position;
      const uv = record.geometry.attributes.uv;
      if (!vertices.length || !position || !uv) {
        return null;
      }
      const targetSet = new Set(vertices);
      const triangleCount = index ? index.count / 3 : Math.floor(position.count / 3);
      let best = null;
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const a = index ? index.getX(triangle * 3) : triangle * 3;
        const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
        const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
        const containsTarget = targetSet.has(a) || targetSet.has(b) || targetSet.has(c);
        const centerUv = new THREE.Vector2(
          (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3,
          (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3
        );
        const distance = target.uvCenter ? this.clonePaintUvDistanceSq(centerUv, target.uvCenter) : 0;
        const score = distance - (containsTarget ? 1000 : 0);
        if (!best || score < best.score) {
          const materialGroups = record.geometry.groups || [];
          const group = materialGroups.find((entry) => (
            triangle * 3 >= entry.start
            && triangle * 3 < entry.start + entry.count
          ));
          best = {
            a,
            b,
            c,
            centerUv,
            materialIndex: group?.materialIndex || 0,
            score
          };
        }
      }
      return best;
    },

    stampClonePaintTargets(options = {}) {
      let changed = 0;
      for (const [record, target] of this.clonePaintTargets || []) {
        const source = this.clonePaintSource?.records?.get(record);
        if (!source || !target?.vertices?.size) {
          continue;
        }
        changed += this.clonePaintTextureNear(record, {
          uv: target.originUv || target.uvCenter,
          face: {
            a: target.originFace?.a || 0,
            b: target.originFace?.b || 0,
            c: target.originFace?.c || 0,
            materialIndex: target.originMaterialIndex ?? target.materialIndex ?? 0
          },
          distance: 0
        }, source, target, { fullRegion: true, status: false });
      }
      if (options.status !== false) {
        this.setStatus(changed > 0
          ? `Clone stamped ${changed} ${changed === 1 ? "pixel" : "pixels"}`
          : "Clone stamp found no texture pixels");
      }
      return changed;
    },

    clonePaintSourceScreenFrame(record, source, options = {}) {
      if (!record || !source?.originFace || !this.canvas || !this.camera) {
        return null;
      }
      const position = record.geometry?.attributes?.position;
      const uvAttribute = record.geometry?.attributes?.uv;
      if (!position || !uvAttribute) {
        return null;
      }
      const material = this.clonePaintMaterialForHit(record, {
        face: {
          materialIndex: source.originMaterialIndex ?? source.materialIndex ?? source.originFace.materialIndex ?? 0
        }
      });
      const editable = this.editableClonePaintTexture(material);
      if (!editable) {
        return null;
      }

      const vertexIndices = source.originFace.vertices || [
        source.originFace.a,
        source.originFace.b,
        source.originFace.c
      ];
      if (vertexIndices.length !== 3) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const referenceUv = source.originUv || source.uvCenter || null;
      const screenPoints = [];
      const texturePoints = [];
      this.model?.updateMatrixWorld?.(true);
      record.object.updateMatrixWorld(true);
      for (const vertexIndex of vertexIndices) {
        if (!Number.isInteger(vertexIndex) || record.deleted?.has(vertexIndex)) {
          return null;
        }
        const local = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        this.applyBoneTransform?.(record.object, vertexIndex, local);
        record.object.localToWorld(local);
        const projected = local.project(this.camera);
        if (projected.z < -1 || projected.z > 1) {
          return null;
        }
        screenPoints.push({
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height
        });
        const uv = new THREE.Vector2(
          uvAttribute.getX(vertexIndex),
          uvAttribute.getY(vertexIndex)
        );
        texturePoints.push(this.textureAirbrushRegionPixelFromUv?.(
          uv,
          editable.canvas,
          editable.texture,
          referenceUv
        ) || this.clonePaintPixelFromUv(uv, editable.canvas, editable.texture, { wrap: false }));
      }
      if (texturePoints.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        return null;
      }
      const screenToTexture = this.clonePaintTriangleTransform?.(screenPoints, texturePoints);
      const textureToScreen = this.clonePaintTriangleTransform?.(texturePoints, screenPoints);
      if (!screenToTexture || !textureToScreen) {
        return null;
      }
      const centerTexture = referenceUv
        ? this.textureAirbrushRegionPixelFromUv?.(referenceUv, editable.canvas, editable.texture, referenceUv)
        : null;
      const centerScreen = centerTexture
        ? this.clonePaintTransformPoint?.(textureToScreen, centerTexture)
        : null;
      const fallbackCenter = screenPoints.reduce((sum, point) => {
        sum.x += point.x / 3;
        sum.y += point.y / 3;
        return sum;
      }, { x: 0, y: 0 });
      return {
        canvas: editable.canvas,
        texture: editable.texture,
        image: options.freeze
          ? editable.context.getImageData(0, 0, editable.canvas.width, editable.canvas.height)
          : null,
        screenToTexture: { ...screenToTexture },
        centerScreen: centerScreen && Number.isFinite(centerScreen.x) && Number.isFinite(centerScreen.y)
          ? centerScreen
          : fallbackCenter
      };
    },

    clonePaintScreenProjectedNear(record, hit, event, source, options = {}) {
      if (!source?.vertices?.size || !record || !hit?.face || !event || !this.canvas || !this.camera) {
        return 0;
      }
      const position = record.geometry.attributes.position;
      const uvAttribute = record.geometry.attributes.uv;
      if (!position || !uvAttribute) {
        return 0;
      }
      const target = options.target || null;
      if (target?.vertices?.size && !this.clonePaintHitInsideRegion(hit, target)) {
        if (options.status !== false) {
          this.setStatus("Brush inside the captured Region");
        }
        return 0;
      }

      const material = this.clonePaintMaterialForHit(record, hit);
      const editable = this.editableClonePaintTexture(material);
      const sourceFrame = source.sourceFrame || (source.sourceFrame = this.clonePaintSourceScreenFrame?.(record, source, { freeze: true }) || null);
      if (!material || !editable || !sourceFrame?.image) {
        if (options.status !== false) {
          this.setStatus("Clone paint needs an editable target texture and sample");
        }
        return 0;
      }

      const rect = this.canvas.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = this.textureBrushRadiusScreenPixels?.() || 24;
      const radiusSq = brushRadius * brushRadius;
      const scatter = this.textureAirbrushScatter?.() ?? 0.35;
      const haloRadius = brushRadius * (1 + scatter * 0.72);
      const referenceUv = options.referenceUv || target?.originUv || target?.uvCenter || hit.uv || null;
      const { canvas, context, texture } = editable;
      const materialIndex = hit.face.materialIndex ?? target?.originMaterialIndex ?? target?.materialIndex ?? 0;
      this.captureTexturePaintCanvasUndoTarget?.(record, material, editable, materialIndex);
      const vertexIndices = hit.face.vertices || [hit.face.a, hit.face.b, hit.face.c];
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
        texturePoints.push(this.textureAirbrushRegionPixelFromUv?.(
          new THREE.Vector2(
            uvAttribute.getX(vertexIndex),
            uvAttribute.getY(vertexIndex)
          ),
          canvas,
          texture,
          referenceUv
        ) || this.clonePaintPixelFromUv(
          new THREE.Vector2(
            uvAttribute.getX(vertexIndex),
            uvAttribute.getY(vertexIndex)
          ),
          canvas,
          texture,
          { wrap: false }
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
      const screenToTexture = this.clonePaintTriangleTransform?.(screenPoints, texturePoints);
      if (!textureToScreen || !screenToTexture) {
        return 0;
      }
      const center = this.clonePaintTransformPoint?.(screenToTexture, pointer);
      if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
        return 0;
      }

      const regionTriangles = target?.vertices?.size
        ? this.clonePaintRegionTextureTriangles?.(
          record,
          target,
          materialIndex,
          canvas,
          texture,
          { referenceUv }
        ) || []
        : null;
      if (target?.vertices?.size && !regionTriangles?.length) {
        return 0;
      }

      const textureBoundsSamples = [
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
        .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
      if (!textureBoundsSamples.length) {
        return 0;
      }
      const maxTextureRadius = Math.max(16, Math.min(256, Math.max(canvas.width, canvas.height) * 0.12));
      const minX = Math.floor(Math.max(center.x - maxTextureRadius, Math.min(...textureBoundsSamples.map((point) => point.x)) - 2));
      const maxX = Math.ceil(Math.min(center.x + maxTextureRadius, Math.max(...textureBoundsSamples.map((point) => point.x)) + 2));
      const minY = Math.floor(Math.max(center.y - maxTextureRadius, Math.min(...textureBoundsSamples.map((point) => point.y)) - 2));
      const maxY = Math.ceil(Math.min(center.y + maxTextureRadius, Math.max(...textureBoundsSamples.map((point) => point.y)) + 2));
      const opacity = Math.max(0.04, Math.min(1, this.textureAirbrushOpacity?.() ?? Number(this.textureBrushOpacity?.value || 0.42)));
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const written = new Set();
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
          const core = Math.pow(
            Math.max(0, 1 - distance / Math.max(1, brushRadius)),
            2.85 - scatter * 1.57
          );
          const halo = scatter * 0.42 * Math.pow(
            Math.max(0, 1 - distance / Math.max(1, haloRadius)),
            2.4
          );
          const alpha = Math.min(0.82, opacity * Math.min(1, core + halo));
          if (alpha <= 0.008) {
            continue;
          }
          const sourceTexturePoint = this.clonePaintTransformPoint?.(sourceFrame.screenToTexture, {
            x: sourceFrame.centerScreen.x + dx,
            y: sourceFrame.centerScreen.y + dy
          });
          const sourcePixel = sourceTexturePoint
            ? this.clonePaintActualPixelFromTexturePoint?.(sourceTexturePoint, sourceFrame.canvas, sourceFrame.texture)
            : null;
          if (!sourcePixel) {
            continue;
          }
          const sourceOffset = (sourcePixel.y * sourceFrame.canvas.width + sourcePixel.x) * 4;
          const r = sourceFrame.image.data[sourceOffset];
          const g = sourceFrame.image.data[sourceOffset + 1];
          const b = sourceFrame.image.data[sourceOffset + 2];
          const a = sourceFrame.image.data[sourceOffset + 3];
          const offset = (actualPixel.y * canvas.width + actualPixel.x) * 4;
          const nextR = clampByte(image.data[offset] * (1 - alpha) + r * alpha);
          const nextG = clampByte(image.data[offset + 1] * (1 - alpha) + g * alpha);
          const nextB = clampByte(image.data[offset + 2] * (1 - alpha) + b * alpha);
          const nextA = Math.max(image.data[offset + 3], a, 255);
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
        if (options.status !== false) {
          this.setStatus("Clone paint found no texture pixels");
        }
        return 0;
      }
      context.putImageData(image, 0, 0);
      texture.needsUpdate = true;
      material.needsUpdate = true;
      this.markTexturePaintStrokeChanged?.();
      this.refreshCloneSpotlightTextures?.(record);
      this.updateClonePaintPreviews?.();
      if (options.status !== false) {
        this.setStatus(`Clone painted ${changed} projected ${changed === 1 ? "pixel" : "pixels"}`);
      }
      return changed;
    },

    clonePaintProjectedFromEvent(event, options = {}) {
      if (!event || !this.canvas || !this.camera || !this.model) {
        return 0;
      }
      const sourceRecords = new Set(this.clonePaintSource?.records?.keys?.() || []);
      if (!sourceRecords.size) {
        this.setStatus("Capture a clone sample first");
        return 0;
      }
      const rect = this.canvas.getBoundingClientRect();
      const paintRecords = (this.textureAirbrushRecords?.() || this.paintRecords || [])
        .filter((record) => record?.object && sourceRecords.has(record));
      if (!paintRecords.length) {
        return 0;
      }
      this.model.updateMatrixWorld?.(true);
      for (const record of paintRecords) {
        record.object.updateMatrixWorld(true);
      }
      this.refreshSkinnedRaycastBounds?.();

      const recordByObject = new Map(paintRecords.map((record) => [record.object, record]));
      const paintObjects = paintRecords.map((record) => record.object);
      const screenCenter = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      const brushRadius = this.textureBrushRadiusScreenPixels?.() || 24;
      const probes = [{ x: screenCenter.x, y: screenCenter.y }];
      const probeRadii = [brushRadius * 0.45, brushRadius * 0.78];
      const probeAngles = [0, Math.PI * 0.25, Math.PI * 0.5, Math.PI * 0.75, Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75];
      for (const radius of probeRadii) {
        for (const angle of probeAngles) {
          probes.push({
            x: screenCenter.x + Math.cos(angle) * radius,
            y: screenCenter.y + Math.sin(angle) * radius
          });
        }
      }

      const hits = [];
      const acceptedFaces = new Set();
      const acceptHit = (hit) => {
        const record = recordByObject.get(hit?.object);
        if (!record || !hit?.face || !hit?.uv) {
          return;
        }
        const recordIndex = paintRecords.indexOf(record);
        const faceKey = `${recordIndex}:${hit.face.a}:${hit.face.b}:${hit.face.c}:${hit.face.materialIndex ?? 0}`;
        if (acceptedFaces.has(faceKey)) {
          return;
        }
        acceptedFaces.add(faceKey);
        hits.push({ record, hit });
      };
      const depthWindow = Math.max(0.018, Number(this.brushRadius?.value || 0.035) * 1.15);
      let frontDistance = null;
      const acceptFrontHits = (intersections, referenceDistance = null) => {
        const nearest = referenceDistance ?? intersections[0]?.distance ?? null;
        if (!Number.isFinite(nearest)) {
          return;
        }
        for (const hit of intersections.slice(0, 4)) {
          if (!hit || hit.distance > nearest + depthWindow) {
            break;
          }
          acceptHit(hit);
        }
      };

      for (const probe of probes) {
        if (probe.x < 0 || probe.y < 0 || probe.x > rect.width || probe.y > rect.height) {
          continue;
        }
        this.pointer.x = (probe.x / rect.width) * 2 - 1;
        this.pointer.y = -(probe.y / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(paintObjects, false);
        if (frontDistance === null && intersections[0]) {
          frontDistance = intersections[0].distance;
        }
        acceptFrontHits(intersections, frontDistance);
      }

      let changed = 0;
      for (const { record, hit } of hits) {
        const source = this.clonePaintSource?.records?.get(record);
        changed += this.clonePaintScreenProjectedNear?.(record, hit, event, source, {
          ...options,
          status: false
        }) || 0;
      }
      if (changed && options.status !== false) {
        this.setStatus(`Clone painted ${changed} projected ${changed === 1 ? "pixel" : "pixels"}`);
      } else if (!changed && options.status !== false) {
        this.setStatus("Clone brush needs the cursor over textured mesh");
      }
      return changed;
    },

    clonePaintTextureNear(record, hit, source, target, options = {}) {
      if (!source?.vertices?.size) {
        if (options.status !== false) {
          this.setStatus("Clone paint needs a sample");
        }
        return 0;
      }
      const hasRegionTarget = Boolean(target?.vertices?.size);
      if (hasRegionTarget && !options.fullRegion && !this.clonePaintHitInsideRegion(hit, target)) {
        if (options.status !== false) {
          this.setStatus("Brush inside the captured Region");
        }
        return 0;
      }

      const targetMaterialIndex = hit?.face?.materialIndex
        ?? target?.originMaterialIndex
        ?? target?.materialIndex
        ?? 0;
      const targetMaterial = this.clonePaintMaterialForHit(record, hit);
      const targetEditable = this.editableClonePaintTexture(targetMaterial);
      const sourceStamp = source.stamp || (source.stamp = this.clonePaintBuildSampleStamp(record, source));
      if (!targetEditable || !sourceStamp?.data) {
        if (options.status !== false) {
          this.setStatus("Clone paint needs an editable target texture and source swatch");
        }
        return 0;
      }

      this.refreshCloneSpotlightTextures?.(record);
      if (!hasRegionTarget && !options.fullRegion && options.event) {
        return this.clonePaintScreenProjectedNear?.(record, hit, options.event, source, options) || 0;
      }
      const {
        canvas: targetCanvas,
        context: targetContext,
        texture: targetTexture
      } = targetEditable;
      this.captureTexturePaintCanvasUndoTarget?.(record, targetMaterial, targetEditable, targetMaterialIndex);
      const radiusPixels = Math.max(
        4,
        Math.round(Number(this.brushRadius?.value || 0.035) * Math.max(targetCanvas.width, targetCanvas.height))
      );
      const output = targetContext.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
      const opacity = Math.max(0.04, Math.min(1, this.textureAirbrushOpacity?.() ?? Number(this.textureBrushOpacity?.value || 0.42)));
      const writtenPixels = new Set();
      let changed = 0;

      const writeClonePixel = (pixelPoint, alpha, stampX, stampY) => {
        const sample = this.clonePaintSampleStampPixel(sourceStamp, stampX, stampY);
        if (!sample) {
          return;
        }
        const actualPixel = this.clonePaintActualPixelFromTexturePoint(pixelPoint, targetCanvas, targetTexture);
        const key = `${actualPixel.x}:${actualPixel.y}`;
        if (writtenPixels.has(key)) {
          return;
        }
        writtenPixels.add(key);
        const [r, g, b, a] = sample;
        const index = (actualPixel.y * targetCanvas.width + actualPixel.x) * 4;
        output.data[index] = Math.round(output.data[index] * (1 - alpha) + r * alpha);
        output.data[index + 1] = Math.round(output.data[index + 1] * (1 - alpha) + g * alpha);
        output.data[index + 2] = Math.round(output.data[index + 2] * (1 - alpha) + b * alpha);
        output.data[index + 3] = Math.round(output.data[index + 3] * (1 - alpha) + a * alpha);
        changed += 1;
      };

      const referenceUv = hit?.uv || target?.originUv || target?.uvCenter;
      const center = referenceUv
        ? this.clonePaintPixelFromUv(referenceUv, targetCanvas, targetTexture, { wrap: false })
        : null;
      if (!hasRegionTarget) {
        if (!center) {
          if (options.status !== false) {
            this.setStatus("Clone brush needs the cursor over textured mesh");
          }
          return 0;
        }
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > radiusPixels) {
              continue;
            }
            const falloff = 1 - distance / radiusPixels;
            const alpha = (0.12 + falloff * 0.88) * opacity;
            const stampX = sourceStamp.canvas.width * 0.5
              + dx * (sourceStamp.canvas.width / Math.max(1, radiusPixels * 2));
            const stampY = sourceStamp.canvas.height * 0.5
              + dy * (sourceStamp.canvas.height / Math.max(1, radiusPixels * 2));
            writeClonePixel({ x: center.x + dx, y: center.y + dy }, alpha, stampX, stampY);
          }
        }
        if (!changed) {
          if (options.status !== false) {
            this.setStatus("Clone paint found no texture pixels");
          }
          return 0;
        }
        targetContext.putImageData(output, 0, 0);
        targetTexture.needsUpdate = true;
        targetMaterial.needsUpdate = true;
        this.refreshCloneSpotlightTextures?.(record);
        this.updateClonePaintPreviews?.();
        if (options.status !== false) {
          this.setStatus(`Clone painted ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
        }
        return changed;
      }

      const targetFaces = this.clonePaintRegionFacesForMaterial(target, targetMaterialIndex);
      if (!targetFaces.length) {
        if (options.status !== false) {
          this.setStatus("Clone paint needs complete Region faces");
        }
        return 0;
      }

      const targetTriangles = this.clonePaintRegionTextureTriangles(
        record,
        target,
        targetMaterialIndex,
        targetCanvas,
        targetTexture,
        { referenceUv }
      );
      if (!targetTriangles.length) {
        if (options.status !== false) {
          this.setStatus("Clone paint needs complete Region texture faces");
        }
        return 0;
      }
      const allTargetPixels = targetTriangles.flatMap((entry) => entry.pixels);
      const regionMinX = allTargetPixels.length ? Math.min(...allTargetPixels.map((point) => point.x)) : 0;
      const regionMaxX = allTargetPixels.length ? Math.max(...allTargetPixels.map((point) => point.x)) : targetCanvas.width - 1;
      const regionMinY = allTargetPixels.length ? Math.min(...allTargetPixels.map((point) => point.y)) : 0;
      const regionMaxY = allTargetPixels.length ? Math.max(...allTargetPixels.map((point) => point.y)) : targetCanvas.height - 1;
      const regionWidth = Math.max(1, regionMaxX - regionMinX);
      const regionHeight = Math.max(1, regionMaxY - regionMinY);

      if (!options.fullRegion) {
        if (!center) {
          return 0;
        }
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > radiusPixels) {
              continue;
            }
            const pixelPoint = {
              x: center.x + dx,
              y: center.y + dy
            };
            if (!this.clonePaintPointInsideTextureTriangles(pixelPoint, targetTriangles, 0.015)) {
              continue;
            }
            const falloff = 1 - distance / radiusPixels;
            const alpha = (0.35 + falloff * 0.65) * opacity;
            const stampX = sourceStamp.canvas.width * 0.5
              + dx * (sourceStamp.canvas.width / Math.max(1, radiusPixels * 2));
            const stampY = sourceStamp.canvas.height * 0.5
              + dy * (sourceStamp.canvas.height / Math.max(1, radiusPixels * 2));
            writeClonePixel(pixelPoint, alpha, stampX, stampY);
          }
        }
      } else {
        for (const { pixels: targetPixels } of targetTriangles) {
          if (targetPixels.length !== 3) {
            continue;
          }
          const minX = Math.floor(Math.min(...targetPixels.map((point) => point.x)));
          const maxX = Math.ceil(Math.max(...targetPixels.map((point) => point.x)));
          const minY = Math.floor(Math.min(...targetPixels.map((point) => point.y)));
          const maxY = Math.ceil(Math.max(...targetPixels.map((point) => point.y)));
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              const pixelPoint = { x, y };
              const targetBarycentric = this.clonePaintBarycentric(pixelPoint, targetPixels);
              if (!this.clonePaintBarycentricInside(targetBarycentric)) {
                continue;
              }
              const stampX = ((x - regionMinX) / regionWidth) * (sourceStamp.canvas.width - 1);
              const stampY = ((y - regionMinY) / regionHeight) * (sourceStamp.canvas.height - 1);
              writeClonePixel(pixelPoint, 1, stampX, stampY);
            }
          }
        }
      }

      if (!changed && !options.fullRegion && center) {
        for (let dy = -radiusPixels; dy <= radiusPixels; dy += 1) {
          for (let dx = -radiusPixels; dx <= radiusPixels; dx += 1) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > radiusPixels) {
              continue;
            }
            const pixelPoint = {
              x: center.x + dx,
              y: center.y + dy
            };
            const falloff = 1 - distance / radiusPixels;
            const alpha = (0.25 + falloff * 0.55) * opacity;
            const stampX = sourceStamp.canvas.width * 0.5
              + dx * (sourceStamp.canvas.width / Math.max(1, radiusPixels * 2));
            const stampY = sourceStamp.canvas.height * 0.5
              + dy * (sourceStamp.canvas.height / Math.max(1, radiusPixels * 2));
            writeClonePixel(pixelPoint, alpha, stampX, stampY);
          }
        }
      }

      if (!changed) {
        if (options.status !== false) {
          this.setStatus("Clone paint found no texture pixels");
        }
        return 0;
      }
      targetContext.putImageData(output, 0, 0);
      targetTexture.needsUpdate = true;
      targetMaterial.needsUpdate = true;
      this.markTexturePaintStrokeChanged?.();
      this.refreshCloneSpotlightTextures?.(record);
      this.updateClonePaintPreviews?.();
      if (options.status !== false) {
        this.setStatus(`Clone painted ${changed} ${changed === 1 ? "pixel" : "pixels"}`);
      }
      return changed;
    },

    clonePaintVerticesNear(record, hit, event = null) {
      const source = this.clonePaintSource?.records?.get(record);
      const target = this.clonePaintTargets?.get(record);
      if (!source) {
        this.setStatus("Capture a clone sample on this mesh first");
        return 0;
      }
      if (event && !target?.vertices?.size) {
        return this.clonePaintProjectedFromEvent?.(event) || 0;
      }
      return this.clonePaintTextureNear(record, hit, source, target, { event });
    }
  });
}
