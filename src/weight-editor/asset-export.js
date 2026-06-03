import { exportMixamoCleanupFbx } from "../../node_modules/fbx-exporter/src/index.js";

export function installAssetExportMethods(BirdWeightEditor, deps) {
  const { THREE, GLTFExporter } = deps;

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function sanitizedFilePart(value, fallback = "animation") {
    return String(value || fallback)
      .replace(/\.[^.]+$/, "")
      .trim()
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || fallback;
  }

  function blobFromExportResult(result, mimeType) {
    if (result instanceof Blob) {
      return result;
    }
    if (result instanceof ArrayBuffer) {
      return new Blob([result], { type: mimeType });
    }
    if (ArrayBuffer.isView(result)) {
      const bytes = result.byteOffset === 0 && result.byteLength === result.buffer.byteLength
        ? result.buffer
        : result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
      return new Blob([bytes], { type: mimeType });
    }
    return new Blob([String(result || "")], { type: mimeType });
  }

  Object.assign(BirdWeightEditor.prototype, {
    syncExportButtons() {
      const enabled = Boolean(this.model);
      if (this.exportGlbButton) {
        this.exportGlbButton.disabled = !enabled;
      }
      if (this.exportFbxButton) {
        this.exportFbxButton.disabled = !enabled;
      }
    },

    exportFileBaseName() {
      const actor = sanitizedFilePart(this.actorTarget?.label || this.actorTarget?.id, "mixamo-cleanup");
      const action = sanitizedFilePart(this.activeClipEntry?.name || this.activeClipEntry?.id, "animation");
      return `${actor}-${action}-clean`;
    },

    async downloadExportBlob(blob, fileName, description, accept) {
      if (typeof window.showSaveFilePicker === "function") {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{
            description,
            accept
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return "file";
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return "download";
    },

    exportTimelineFrameCount() {
      return Math.max(1, Math.round(finiteNumber(this.timelineFrames, 96)));
    },

    exportAnimationDurationSeconds() {
      const info = this.clipSampleInfoForEntry?.(this.activeClipEntry);
      if (info?.sampleDuration > 0) {
        return info.sampleDuration;
      }
      return Math.max(0.001, finiteNumber(this.currentActionDuration?.(), 3));
    },

    exportFrameRate() {
      const duration = this.exportAnimationDurationSeconds();
      const frameCount = this.exportTimelineFrameCount();
      return Math.max(1, Math.round(frameCount / Math.max(0.001, duration)));
    },

    exportAnimatedObjects() {
      if (!this.model) {
        return [];
      }
      const objects = [];
      const seen = new Set();
      const addObject = (object) => {
        if (!object || seen.has(object.uuid)) {
          return;
        }
        seen.add(object.uuid);
        objects.push(object);
      };
      addObject(this.model);
      for (const bone of this.bones?.values?.() || []) {
        addObject(bone);
      }
      return objects;
    },

    captureExportEditorState() {
      return {
        progress: this.progress,
        lastClipSampleTime: this.lastClipSampleTime,
        playing: this.playing,
        rootMotionLoopCycles: this.rootMotionLoopCycles || 0,
        timeScrubValue: this.timeScrub?.value,
        timelineScrubValue: this.timelineScrub?.value
      };
    },

    restoreExportEditorState(state) {
      if (!state) {
        return;
      }
      this.rootMotionLoopCycles = state.rootMotionLoopCycles || 0;
      this.rootMotionCameraFollowPoint = null;
      this.progress = finiteNumber(state.progress, 0);
      this.lastClipSampleTime = state.lastClipSampleTime;
      this.applyPose(this.progress);
      if (this.timeScrub && state.timeScrubValue !== undefined) {
        this.timeScrub.value = state.timeScrubValue;
      }
      if (this.timelineScrub && state.timelineScrubValue !== undefined) {
        this.timelineScrub.value = state.timelineScrubValue;
      }
      this.syncPlaybackReadouts?.({ force: true });
      this.syncPoseControlsToCurrentBone?.();
      if (state.playing) {
        this.setPlayback?.(true);
      }
    },

    bakeCurrentAnimationClipForExport() {
      if (!this.model) {
        return null;
      }
      const objects = this.exportAnimatedObjects();
      if (!objects.length) {
        return null;
      }
      const frameCount = this.exportTimelineFrameCount();
      const duration = this.exportAnimationDurationSeconds();
      const times = new Float32Array(frameCount + 1);
      for (let frame = 0; frame <= frameCount; frame += 1) {
        times[frame] = (frame / frameCount) * duration;
      }

      const samples = new Map(objects.map((object) => [object.uuid, {
        object,
        positions: new Float32Array((frameCount + 1) * 3),
        quaternions: new Float32Array((frameCount + 1) * 4),
        scales: new Float32Array((frameCount + 1) * 3),
        previousQuaternion: null
      }]));

      this.resetRootMotionPreview?.();
      for (let frame = 0; frame <= frameCount; frame += 1) {
        const progress = frame / frameCount;
        this.progress = progress;
        this.applyPose(progress);
        this.model.updateMatrixWorld(true);
        for (const sample of samples.values()) {
          const { object } = sample;
          const positionOffset = frame * 3;
          sample.positions[positionOffset] = object.position.x;
          sample.positions[positionOffset + 1] = object.position.y;
          sample.positions[positionOffset + 2] = object.position.z;

          const quaternion = object.quaternion.clone();
          if (sample.previousQuaternion && sample.previousQuaternion.dot(quaternion) < 0) {
            quaternion.x *= -1;
            quaternion.y *= -1;
            quaternion.z *= -1;
            quaternion.w *= -1;
          }
          sample.previousQuaternion = quaternion.clone();
          const quaternionOffset = frame * 4;
          sample.quaternions[quaternionOffset] = quaternion.x;
          sample.quaternions[quaternionOffset + 1] = quaternion.y;
          sample.quaternions[quaternionOffset + 2] = quaternion.z;
          sample.quaternions[quaternionOffset + 3] = quaternion.w;

          sample.scales[positionOffset] = object.scale.x;
          sample.scales[positionOffset + 1] = object.scale.y;
          sample.scales[positionOffset + 2] = object.scale.z;
        }
      }

      const tracks = [];
      for (const sample of samples.values()) {
        const prefix = sample.object.uuid;
        tracks.push(new THREE.VectorKeyframeTrack(`${prefix}.position`, times, sample.positions));
        tracks.push(new THREE.QuaternionKeyframeTrack(`${prefix}.quaternion`, times, sample.quaternions));
        tracks.push(new THREE.VectorKeyframeTrack(`${prefix}.scale`, times, sample.scales));
      }
      const name = this.activeClipEntry?.name || this.activeClipEntry?.id || "Cleaned Animation";
      return new THREE.AnimationClip(`${name} Clean`, duration, tracks);
    },

    async exportGlbAsset() {
      if (!this.model) {
        this.setStatus("Load a model before exporting");
        return false;
      }
      const state = this.captureExportEditorState();
      try {
        this.setStatus("Baking GLB export");
        this.setPlayback?.(false);
        this.resetRootMotionPreview?.({ clearProfile: true });
        const bakedClip = this.bakeCurrentAnimationClipForExport();
        this.progress = 0;
        this.applyPose(0);
        this.model.updateMatrixWorld(true);

        const exporter = new GLTFExporter();
        const result = await exporter.parseAsync(this.model, {
          binary: true,
          animations: bakedClip ? [bakedClip] : [],
          onlyVisible: false,
          includeCustomExtensions: false,
          truncateDrawRange: false
        });
        const fileName = `${this.exportFileBaseName()}.glb`;
        const blob = blobFromExportResult(result, "model/gltf-binary");
        const mode = await this.downloadExportBlob(blob, fileName, "Binary glTF", {
          "model/gltf-binary": [".glb"]
        });
        this.setStatus(`${mode === "file" ? "Saved" : "Downloaded"} ${fileName}`);
        return true;
      } catch (error) {
        console.warn("Could not export GLB", error);
        this.setStatus(error?.name === "AbortError" ? "GLB export cancelled" : "Could not export GLB");
        return false;
      } finally {
        this.restoreExportEditorState(state);
      }
    },

    async exportFbxAsset() {
      if (!this.model) {
        this.setStatus("Load a model before exporting");
        return false;
      }
      const state = this.captureExportEditorState();
      try {
        this.setStatus("Baking FBX export");
        this.setPlayback?.(false);
        this.resetRootMotionPreview?.({ clearProfile: true });
        const bakedClip = this.bakeCurrentAnimationClipForExport();
        this.progress = 0;
        this.applyPose(0);
        this.model.updateMatrixWorld(true);

        const warnings = [];
        const bytes = exportMixamoCleanupFbx({
          object3D: this.model,
          animations: bakedClip ? [bakedClip] : [],
          frameRate: this.exportFrameRate()
        }, {
          embedTextures: true,
          textureTransformMode: "blender",
          bakeAnimations: true,
          warnings,
          onWarning: (warning) => console.warn("FBX export warning", warning)
        });

        const fileName = `${this.exportFileBaseName()}.fbx`;
        const blob = blobFromExportResult(bytes, "application/octet-stream");
        const mode = await this.downloadExportBlob(blob, fileName, "FBX", {
          "application/octet-stream": [".fbx"]
        });
        const warningText = warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "";
        this.setStatus(`${mode === "file" ? "Saved" : "Downloaded"} ${fileName}${warningText}`);
        return true;
      } catch (error) {
        console.warn("Could not export FBX", error);
        this.setStatus(error?.name === "AbortError" ? "FBX export cancelled" : "Could not export FBX");
        return false;
      } finally {
        this.restoreExportEditorState(state);
      }
    }
  });
}
