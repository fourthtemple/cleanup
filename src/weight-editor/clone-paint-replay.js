export function installClonePaintReplayMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  function vector2Json(vector) {
    return vector
      ? { x: Number(vector.x.toFixed(6)), y: Number(vector.y.toFixed(6)) }
      : null;
  }

  function verticesJson(vertices) {
    return [...(vertices || [])].sort((left, right) => left - right);
  }

  function parseReplayPayload(input) {
    if (!input) {
      return null;
    }
    if (typeof input === "string") {
      return JSON.parse(input);
    }
    return input;
  }

  Object.assign(BirdWeightEditor.prototype, {
    installClonePaintReplayConsole() {
      if (typeof window === "undefined") {
        return;
      }
      window.mixamoCleanupCloneReplay = {
        capture: () => this.captureClonePaintReplayJson(),
        copy: async () => this.copyClonePaintReplayJson(),
        replay: (json, options = {}) => this.replayClonePaintJson(json, options),
        stamp: (json, options = {}) => this.replayClonePaintJson(json, { ...options, stamp: true })
      };
      if (this.clonePaintReplayDomBridgeInstalled || typeof document === "undefined") {
        return;
      }
      this.clonePaintReplayDomBridgeInstalled = true;
      const runDomCommand = (detail = {}) => {
        const id = detail.id || `${Date.now()}`;
        let result;
        try {
          result = this.runClonePaintReplayCommand(detail.command, detail.payload || {});
        } catch (error) {
          result = {
            ok: false,
            error: error?.message || String(error)
          };
        }
        const text = JSON.stringify({ id, result });
        document.documentElement.setAttribute("data-mixamo-cleanup-clone-replay-result", text);
        return { id, result };
      };
      document.addEventListener("mixamo-cleanup-clone-replay-command", (event) => {
        const { id, result } = runDomCommand(event.detail || {});
        document.dispatchEvent(new CustomEvent("mixamo-cleanup-clone-replay-result", {
          detail: { id, result }
        }));
      });
      window.setInterval(() => {
        const text = document.documentElement.getAttribute("data-mixamo-cleanup-clone-replay-request") || "";
        if (!text || text === this.clonePaintReplayLastDomRequest) {
          return;
        }
        this.clonePaintReplayLastDomRequest = text;
        try {
          runDomCommand(JSON.parse(text));
        } catch (error) {
          document.documentElement.setAttribute("data-mixamo-cleanup-clone-replay-result", JSON.stringify({
            id: "",
            result: {
              ok: false,
              error: error?.message || String(error)
            }
          }));
        }
      }, 50);
    },

    clonePaintReplayRegionBounds() {
      this.updateCloneSpotlight?.();
      const box = new THREE.Box3();
      let pointCount = 0;
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (!overlay?.visible || overlay.userData?.cloneSpotlightKind !== "target") {
          continue;
        }
        const position = overlay.geometry?.attributes?.position;
        if (!position) {
          continue;
        }
        overlay.updateMatrixWorld(true);
        for (let index = 0; index < position.count; index += 1) {
          const local = new THREE.Vector3().fromBufferAttribute(position, index);
          this.applyBoneTransform?.(overlay, index, local);
          overlay.localToWorld(local);
          box.expandByPoint(local);
          pointCount += 1;
        }
      }
      if (!pointCount || box.isEmpty()) {
        return null;
      }
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      return { box, center, size, pointCount };
    },

    focusClonePaintReplayRegion(options = {}) {
      const bounds = this.clonePaintReplayRegionBounds?.();
      if (!bounds || !this.camera || !this.controls) {
        return { ok: false, reason: "no-region" };
      }
      const { center, size, pointCount } = bounds;
      const radius = Math.max(size.length() * 0.5, 0.18);
      const fov = THREE.MathUtils.degToRad(this.camera.fov || 45);
      const distance = Math.max(radius / Math.tan(fov * 0.5) * 1.35, radius * 3.5, 0.5);
      const pitch = Number.isFinite(options.pitch) ? options.pitch : 0.78;
      const side = Number.isFinite(options.side) ? options.side : -0.24;
      const forward = Number.isFinite(options.forward) ? options.forward : 0.62;
      const direction = new THREE.Vector3(side, pitch, forward).normalize();
      this.controls.target.copy(center);
      this.camera.position.copy(center).addScaledVector(direction, distance);
      this.camera.near = Math.max(0.001, distance / 100);
      this.camera.far = Math.max(this.camera.far || 1000, distance * 100);
      this.camera.lookAt(center);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.render?.();
      return {
        ok: true,
        pointCount,
        center: { x: center.x, y: center.y, z: center.z },
        size: { x: size.x, y: size.y, z: size.z },
        camera: {
          x: this.camera.position.x,
          y: this.camera.position.y,
          z: this.camera.position.z
        }
      };
    },

    clonePaintReplayRegionScreenCenter() {
      const bounds = this.clonePaintReplayRegionScreenBounds?.();
      if (!bounds) {
        return null;
      }
      return {
        clientX: (bounds.minX + bounds.maxX) * 0.5,
        clientY: (bounds.minY + bounds.maxY) * 0.5
      };
    },

    clonePaintReplayRegionScreenBounds() {
      if (!this.canvas || !this.camera) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let pointCount = 0;
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (!overlay?.visible || overlay.userData?.cloneSpotlightKind !== "target") {
          continue;
        }
        const position = overlay.geometry?.attributes?.position;
        if (!position) {
          continue;
        }
        overlay.updateMatrixWorld(true);
        for (let index = 0; index < position.count; index += 1) {
          const local = new THREE.Vector3().fromBufferAttribute(position, index);
          this.applyBoneTransform?.(overlay, index, local);
          overlay.localToWorld(local);
          const projected = local.project(this.camera);
          if (projected.z < -1 || projected.z > 1) {
            continue;
          }
          const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
          const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          pointCount += 1;
        }
      }
      if (!pointCount) {
        return null;
      }
      return { minX, maxX, minY, maxY, pointCount };
    },

    airbrushClonePaintReplayRegion(options = {}) {
      const center = this.clonePaintReplayRegionScreenCenter?.();
      if (!center) {
        return { ok: false, changed: 0, reason: "no-region" };
      }
      this.setTool?.("airbrush");
      const event = {
        button: 0,
        clientX: center.clientX + (options.offsetX || 0),
        clientY: center.clientY + (options.offsetY || 0)
      };
      const beforeStatus = this.statusText?.textContent || "";
      this.paintFromEvent?.(event);
      const status = this.statusText?.textContent || "";
      return {
        ok: true,
        event,
        beforeStatus,
        status
      };
    },

    airbrushClonePaintReplayRegionSweep(options = {}) {
      const bounds = this.clonePaintReplayRegionScreenBounds?.();
      if (!bounds) {
        return { ok: false, changed: 0, reason: "no-region" };
      }
      this.setTool?.("airbrush");
      const radius = this.textureBrushRadiusScreenPixels?.() || 24;
      const step = Math.max(6, Number(options.step || radius * 0.56));
      const pad = radius * 0.45;
      let strokes = 0;
      const minX = bounds.minX - pad;
      const maxX = bounds.maxX + pad;
      const minY = bounds.minY - pad;
      const maxY = bounds.maxY + pad;
      const columns = Math.max(1, Math.min(6, Math.ceil((maxX - minX) / step)));
      const rows = Math.max(1, Math.min(6, Math.ceil((maxY - minY) / step)));
      for (let row = 0; row < rows; row += 1) {
        const y = rows === 1 ? (minY + maxY) * 0.5 : minY + ((maxY - minY) * row) / (rows - 1);
        for (let column = 0; column < columns; column += 1) {
          const x = columns === 1 ? (minX + maxX) * 0.5 : minX + ((maxX - minX) * column) / (columns - 1);
          this.paintFromEvent?.({
            button: 0,
            clientX: x,
            clientY: y
          });
          strokes += 1;
        }
      }
      return {
        ok: true,
        strokes,
        bounds,
        status: this.statusText?.textContent || ""
      };
    },

    airbrushClonePaintReplayPoints(options = {}) {
      const rawPoints = Array.isArray(options.points)
        ? options.points
        : String(options.points || "")
          .split(";")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => entry.split(",").map((value) => Number(value.trim())));
      const points = rawPoints.filter((point) => (
        point.length >= 2
        && Number.isFinite(point[0])
        && Number.isFinite(point[1])
      ));
      if (!points.length) {
        return { ok: false, changed: 0, reason: "no-points" };
      }
      this.setTool?.("airbrush");
      let changed = 0;
      let hits = 0;
      for (const [clientX, clientY] of points) {
        const event = { button: 0, clientX, clientY };
        const hit = this.texturePaintHitForEvent?.(event, "airbrush");
        if (!hit) {
          continue;
        }
        hits += 1;
        changed += this.textureAirbrushNear?.(hit.record, hit.hit, { event }) || 0;
      }
      return {
        ok: true,
        hits,
        changed,
        status: this.statusText?.textContent || ""
      };
    },

    runClonePaintReplayCommand(command, payload = {}) {
      if (command === "state") {
        return {
          ok: true,
          status: this.statusText?.textContent || "",
          activeTool: this.activeTool,
          viewMode: this.viewMode,
          overlays: this.cloneSpotlightOverlays?.length || 0,
          targetCount: [...(this.clonePaintTargets?.values?.() || [])]
            .reduce((sum, target) => sum + (target?.vertices?.size || 0), 0)
        };
      }
      if (command === "focus-region") {
        return this.focusClonePaintReplayRegion(payload);
      }
      if (command === "airbrush-region") {
        return this.airbrushClonePaintReplayRegion(payload);
      }
      if (command === "airbrush-region-sweep") {
        return this.airbrushClonePaintReplayRegionSweep(payload);
      }
      if (command === "airbrush-points") {
        return this.airbrushClonePaintReplayPoints(payload);
      }
      if (command === "fill-region") {
        return {
          ok: true,
          changed: this.paintTextureRegion?.(payload) || 0,
          status: this.statusText?.textContent || ""
        };
      }
      return { ok: false, reason: "unknown-command", command };
    },

    clonePaintReplayUrlFromLocation() {
      if (typeof window === "undefined") {
        return "";
      }
      const value = new URL(window.location.href).searchParams.get("cloneReplay");
      if (!value) {
        return "";
      }
      const url = new URL(value, window.location.href);
      return url.origin === window.location.origin ? url.href : "";
    },

    async maybeReplayClonePaintFromUrl() {
      const url = this.clonePaintReplayUrlFromLocation?.();
      if (!url || this.clonePaintAutoReplayUrl === url) {
        return null;
      }
      this.clonePaintAutoReplayUrl = url;
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.text();
        const result = this.replayClonePaintJson(json);
        const params = new URL(window.location.href).searchParams;
        const focus = params.get("cloneReplayFocus");
        const paint = params.get("cloneReplayPaint");
        const probe = params.get("cloneReplayProbe");
        if (probe === "airbrush" || probe === "clone") {
          requestAnimationFrame(() => this.probeCloneReplayPaint?.(probe));
        } else if (focus === "region" || paint) {
          requestAnimationFrame(() => {
            this.focusClonePaintReplayRegion?.({
              pitch: Number(params.get("cloneReplayPitch")),
              side: Number(params.get("cloneReplaySide")),
              forward: Number(params.get("cloneReplayForward"))
            });
            this.setStatus(`Replayed clone paint fixture: ${result.sourceCount} source / ${result.targetCount} region`);
          });
        } else {
          this.setStatus(`Replayed clone paint fixture: ${result.sourceCount} source / ${result.targetCount} region`);
        }
        return result;
      } catch (error) {
        console.warn("Could not replay clone paint fixture", error);
        this.setStatus("Could not replay clone paint fixture");
        return null;
      }
    },

    clonePaintRecordReplayId(record, index) {
      return {
        index,
        objectName: record.object?.name || "",
        geometryUuid: record.geometry?.uuid || "",
        vertexCount: record.geometry?.attributes?.position?.count || 0,
        uvCount: record.geometry?.attributes?.uv?.count || 0
      };
    },

    clonePaintReplayMaterialInfo(record) {
      return this.getObjectMaterials(record.object?.material).map((material, index) => {
        const image = material?.map?.image;
        return {
          index,
          name: material?.name || "",
          hasMap: Boolean(material?.map),
          mapName: material?.map?.name || "",
          imageWidth: image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width || 0,
          imageHeight: image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height || 0,
          editableCanvas: Boolean(material?.userData?.clonePaintCanvas)
        };
      });
    },

    captureClonePaintReplay(options = {}) {
      const records = (this.paintRecords || []).map((record, index) => {
        const source = this.clonePaintSource?.records?.get(record);
        const target = this.clonePaintTargets?.get(record);
        return {
          ...this.clonePaintRecordReplayId(record, index),
          selectedVertices: verticesJson(record.selected),
          sourceVertices: verticesJson(source?.vertices),
          targetVertices: verticesJson(target?.vertices),
          sourceUvCenter: vector2Json(source?.uvCenter),
          targetUvCenter: vector2Json(target?.uvCenter),
          sourceOriginUv: vector2Json(source?.originUv),
          targetOriginUv: vector2Json(target?.originUv),
          sourceMaterialIndex: source?.originMaterialIndex ?? source?.materialIndex ?? null,
          targetMaterialIndex: target?.originMaterialIndex ?? target?.materialIndex ?? null,
          materials: this.clonePaintReplayMaterialInfo(record)
        };
      });
      return {
        schema: "mixamo-cleanup.clone-paint-replay",
        version: 1,
        capturedAt: new Date().toISOString(),
        reason: options.reason || "manual clone paint replay",
        activeTool: this.activeTool,
        viewMode: this.viewMode,
        status: this.statusText?.textContent || "",
        brushRadius: Number(this.brushRadius?.value || 0),
        modelName: this.model?.name || "",
        clipName: this.activeAction?.getClip?.()?.name || this.clip?.name || "",
        sourceCount: this.clonePaintSource?.count || 0,
        targetCount: records.reduce((sum, record) => sum + record.targetVertices.length, 0),
        records
      };
    },

    captureClonePaintReplayJson(options = {}) {
      return JSON.stringify(this.captureClonePaintReplay(options), null, 2);
    },

    async copyClonePaintReplayJson(options = {}) {
      const json = this.captureClonePaintReplayJson(options);
      let copied = false;
      let output = this.clonePaintJsonOutput;
      if (!output && typeof document !== "undefined") {
        output = document.createElement("textarea");
        output.setAttribute("readonly", "");
        output.style.position = "fixed";
        output.style.left = "-9999px";
        document.body.append(output);
      }
      if (output) {
        output.hidden = false;
        output.value = json;
        output.focus();
        output.select();
        output.setSelectionRange?.(0, json.length);
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(json);
          copied = true;
        }
      } catch (error) {
        console.warn("Clipboard API could not copy clone replay JSON", error);
      }
      if (!copied && output) {
        try {
          copied = document.execCommand("copy");
        } catch (error) {
          console.warn("Legacy copy could not copy clone replay JSON", error);
        }
      }
      if (output && output !== this.clonePaintJsonOutput) {
        output.remove();
      }
      this.setStatus(copied ? "Clone replay JSON copied" : "Clone replay JSON shown; press Cmd+C");
      if (this.clonePaintStatus) {
        this.clonePaintStatus.textContent = copied ? "Replay JSON copied" : "Replay JSON selected; press Cmd+C";
      }
      console.log(json);
      return json;
    },

    clonePaintReplayFindRecord(recordPayload) {
      const records = this.paintRecords || [];
      if (!recordPayload) {
        return null;
      }
      if (recordPayload.geometryUuid) {
        const byGeometry = records.find((record) => record.geometry?.uuid === recordPayload.geometryUuid);
        if (byGeometry) {
          return byGeometry;
        }
      }
      if (recordPayload.objectName) {
        const byName = records.find((record) => record.object?.name === recordPayload.objectName);
        if (byName) {
          return byName;
        }
      }
      return records[recordPayload.index] || null;
    },

    clonePaintReplayRegion(record, vertices, uvCenter = null, originUv = null, materialIndex = null) {
      const cleanVertices = (vertices || [])
        .filter((vertexIndex) => Number.isInteger(vertexIndex)
          && vertexIndex >= 0
          && vertexIndex < record.geometry.attributes.position.count
          && !record.deleted?.has(vertexIndex));
      const region = this.clonePaintRegionFromVertices?.(record, cleanVertices) || {
        centerOriginal: this.cloneRegionCenter(record, cleanVertices),
        uvCenter: this.cloneRegionUvCenter(record, cleanVertices),
        samples: cleanVertices.map((vertexIndex) => ({
          vertexIndex,
          original: this.cloneReplayOriginalPositionVector(record, vertexIndex),
          current: this.cloneReplayCurrentPositionVector(record, vertexIndex)
        })),
        vertices: new Set(cleanVertices)
      };
      region.uvCenter = uvCenter && Number.isFinite(uvCenter.x) && Number.isFinite(uvCenter.y)
          ? new THREE.Vector2(uvCenter.x, uvCenter.y)
          : region.uvCenter;
      region.originUv = originUv && Number.isFinite(originUv.x) && Number.isFinite(originUv.y)
        ? new THREE.Vector2(originUv.x, originUv.y)
        : region.originUv || region.uvCenter?.clone?.() || null;
      if (Number.isInteger(materialIndex)) {
        region.materialIndex = materialIndex;
        region.originMaterialIndex = materialIndex;
      }
      return region;
    },

    cloneReplayOriginalPositionVector(record, vertexIndex) {
      const offset = vertexIndex * 3;
      return new THREE.Vector3(
        record.originalPosition[offset],
        record.originalPosition[offset + 1],
        record.originalPosition[offset + 2]
      );
    },

    cloneReplayCurrentPositionVector(record, vertexIndex) {
      return new THREE.Vector3().fromBufferAttribute(record.geometry.attributes.position, vertexIndex);
    },

    applyClonePaintReplay(payload, options = {}) {
      const parsed = parseReplayPayload(payload);
      if (!parsed || parsed.schema !== "mixamo-cleanup.clone-paint-replay") {
        throw new Error("Expected mixamo-cleanup.clone-paint-replay JSON");
      }

      const sourceRecords = new Map();
      const targetRecords = new Map();
      let sourceCount = 0;
      let targetCount = 0;
      const missing = [];

      for (const recordPayload of parsed.records || []) {
        const record = this.clonePaintReplayFindRecord(recordPayload);
        if (!record) {
          missing.push(recordPayload.objectName || recordPayload.geometryUuid || `record ${recordPayload.index}`);
          continue;
        }
        const source = this.clonePaintReplayRegion(
          record,
          recordPayload.sourceVertices,
          recordPayload.sourceUvCenter,
          recordPayload.sourceOriginUv,
          recordPayload.sourceMaterialIndex
        );
        const target = this.clonePaintReplayRegion(
          record,
          recordPayload.targetVertices,
          recordPayload.targetUvCenter,
          recordPayload.targetOriginUv,
          recordPayload.targetMaterialIndex
        );
        source.stamp = this.clonePaintBuildSampleStamp?.(record, source) || source.stamp || null;
        if (source.vertices.size) {
          sourceRecords.set(record, source);
          sourceCount += source.vertices.size;
        }
        if (target.vertices.size) {
          targetRecords.set(record, {
            ...target,
            centerOriginal: target.centerOriginal,
            uvCenter: target.uvCenter,
            offset: source.centerOriginal ? target.centerOriginal.clone().sub(source.centerOriginal) : new THREE.Vector3(),
            vertices: target.vertices
          });
          targetCount += target.vertices.size;
        }
      }

      this.clonePaintSource = { records: sourceRecords, count: sourceCount };
      this.clonePaintTargets = targetRecords;
      this.syncClonePaintControls?.();
      const armed = this.activateClonePaintTool?.({ stamp: Boolean(options.stamp) });
      this.updateCloneSpotlight?.();
      this.updateClonePaintPreviews?.();
      const result = { armed, sourceCount, targetCount, missing };
      if (missing.length) {
        this.setStatus(`Clone replay missing ${missing.length} mesh ${missing.length === 1 ? "record" : "records"}`);
      }
      return result;
    },

    stampClonePaintReplay(payload) {
      const replay = this.applyClonePaintReplay(payload, { stamp: false });
      const changed = this.stampClonePaintTargets?.() || 0;
      return { ...replay, changed };
    },

    replayClonePaintJson(json, options = {}) {
      const payload = parseReplayPayload(json);
      return options.stamp
        ? this.stampClonePaintReplay(payload)
        : this.applyClonePaintReplay(payload);
    }
  });
}
