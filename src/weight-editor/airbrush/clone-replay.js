export function installTextureAirbrushCloneReplayMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    cloneReplayProbeEventFromRegion() {
      this.updateCloneSpotlight?.();
      const targetOverlays = (this.cloneSpotlightOverlays || []).filter((item) => (
        item.userData?.cloneSpotlightKind === "target"
      ));
      const overlay = targetOverlays.find((item) => (
        item.visible
        && item.geometry?.attributes?.position?.count >= 3
      ));
      this.cloneReplayProbeDebug = {
        overlays: this.cloneSpotlightOverlays?.length || 0,
        targetOverlays: targetOverlays.length,
        targetVertices: [...(this.clonePaintTargets?.values?.() || [])]
          .reduce((sum, target) => sum + (target?.vertices?.size || 0), 0),
        targetOverlayVertices: targetOverlays.reduce((sum, item) => (
          sum + (item.geometry?.attributes?.position?.count || 0)
        ), 0)
      };
      if (!overlay || !this.canvas || !this.camera) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const position = overlay.geometry.attributes.position;
      const center = new THREE.Vector3();
      overlay.updateMatrixWorld(true);
      for (let index = 0; index < 3; index += 1) {
        const local = new THREE.Vector3().fromBufferAttribute(position, index);
        this.applyBoneTransform?.(overlay, index, local);
        overlay.localToWorld(local);
        center.add(local);
      }
      center.multiplyScalar(1 / 3).project(this.camera);
      return {
        button: 0,
        clientX: rect.left + (center.x * 0.5 + 0.5) * rect.width,
        clientY: rect.top + (-center.y * 0.5 + 0.5) * rect.height
      };
    },

    cloneReplayRegionTextureSamples(record, hit) {
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const editable = this.editableClonePaintTexture?.(material);
      const target = this.clonePaintTargets?.get(record);
      if (!editable || !target?.vertices?.size) {
        return null;
      }
      const { canvas, context, texture } = editable;
      const materialIndex = hit?.face?.materialIndex
        ?? target.originMaterialIndex
        ?? target.materialIndex
        ?? 0;
      const triangles = this.clonePaintRegionTextureTriangles?.(
        record,
        target,
        materialIndex,
        canvas,
        texture,
        { referenceUv: hit?.uv || target.originUv || target.uvCenter }
      );
      if (!triangles?.length) {
        return null;
      }
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const samples = new Map();
      let checksum = 2166136261;
      const addPixel = (point) => {
        const actual = this.clonePaintActualPixelFromTexturePoint?.(point, canvas, texture);
        if (!actual) {
          return;
        }
        const key = `${actual.x}:${actual.y}`;
        if (samples.has(key)) {
          return;
        }
        const offset = (actual.y * canvas.width + actual.x) * 4;
        const packed = (
          (image.data[offset] << 24)
          | (image.data[offset + 1] << 16)
          | (image.data[offset + 2] << 8)
          | image.data[offset + 3]
        ) >>> 0;
        samples.set(key, packed);
        checksum ^= packed;
        checksum = Math.imul(checksum, 16777619) >>> 0;
      };

      for (const triangle of triangles) {
        const pixels = triangle.pixels || [];
        if (pixels.length !== 3) {
          continue;
        }
        const minX = Math.floor(Math.min(...pixels.map((point) => point.x)));
        const maxX = Math.ceil(Math.max(...pixels.map((point) => point.x)));
        const minY = Math.floor(Math.min(...pixels.map((point) => point.y)));
        const maxY = Math.ceil(Math.max(...pixels.map((point) => point.y)));
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const point = { x, y };
            const barycentric = this.clonePaintBarycentric(point, pixels);
            if (this.clonePaintBarycentricInside(barycentric, 0.015)) {
              addPixel(point);
            }
          }
        }
      }
      return { checksum, count: samples.size, samples };
    },

    cloneReplayCompareTextureSamples(before, after) {
      if (!before || !after) {
        return null;
      }
      let changed = 0;
      for (const [key, value] of after.samples) {
        if (before.samples.get(key) !== value) {
          changed += 1;
        }
      }
      return {
        changed,
        beforeCount: before.count,
        afterCount: after.count,
        beforeChecksum: before.checksum,
        afterChecksum: after.checksum
      };
    },

    probeCloneReplayPaint(tool = "airbrush") {
      const paintTool = tool === "clone" ? "clone" : "airbrush";
      const event = this.cloneReplayProbeEventFromRegion?.();
      if (!event) {
        const debug = this.cloneReplayProbeDebug || {};
        this.setStatus(`Clone replay probe found ${debug.targetOverlayVertices || 0} Region overlay vertices from ${debug.targetVertices || 0} region vertices`);
        return { changed: 0, hit: false };
      }
      if (paintTool === "clone") {
        this.activateClonePaintTool?.();
      } else {
        this.setTool?.("airbrush");
      }
      const hit = this.texturePaintHitForEvent?.(event, paintTool);
      if (!hit) {
        this.setStatus(`Clone replay ${paintTool} probe missed Region`);
        return { changed: 0, hit: false };
      }
      const before = this.cloneReplayRegionTextureSamples?.(hit.record, hit.hit);
      this.paintFromEvent?.(event);
      const after = this.cloneReplayRegionTextureSamples?.(hit.record, hit.hit);
      const diff = this.cloneReplayCompareTextureSamples?.(before, after);
      if (!diff) {
        this.setStatus(`Clone replay ${paintTool} probe could not sample Region texture`);
        return { changed: 0, hit: true };
      }
      this.setStatus(`Clone replay ${paintTool} event changed ${diff.changed} Region ${diff.changed === 1 ? "pixel" : "pixels"}`);
      return { ...diff, hit: true, tool: paintTool };
    },

    probeCloneReplayAirbrush() {
      return this.probeCloneReplayPaint?.("airbrush");
    }
  });
}
