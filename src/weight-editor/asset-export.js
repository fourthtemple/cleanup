import { exportCharacterFbx } from "@fourthtemple/fbx-exporter";

export function installAssetExportMethods(BirdWeightEditor, deps) {
  const { THREE, GLTFExporter, SkeletonUtils } = deps;
  const EXPORT_TEXTURE_FIELDS = [
    "map",
    "alphaMap",
    "aoMap",
    "bumpMap",
    "displacementMap",
    "emissiveMap",
    "envMap",
    "lightMap",
    "metalnessMap",
    "normalMap",
    "roughnessMap",
    "specularMap"
  ];

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

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array();
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function dataUrlBytes(dataUrl = "") {
    const match = String(dataUrl).match(/^data:[^,]*;base64,(.*)$/);
    if (!match) {
      return null;
    }
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function textureUserDataBytes(texture) {
    const value = texture?.userData?.content || texture?.userData?.bytes || texture?.userData?.data;
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function textureExtensionForMime(mimeType = "") {
    const normalized = String(mimeType || "").toLowerCase();
    if (normalized.includes("png")) {
      return "png";
    }
    if (normalized.includes("jpeg") || normalized.includes("jpg")) {
      return "jpg";
    }
    return "png";
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
      if (this.animationLibrarySaveFbxButton) {
        this.animationLibrarySaveFbxButton.disabled = !enabled;
      }
      if (this.animationLibrarySaveGlbButton) {
        this.animationLibrarySaveGlbButton.disabled = !enabled;
      }
    },

    exportFileBaseName() {
      const actor = sanitizedFilePart(this.actorTarget?.label || this.actorTarget?.id, "mixamo-cleanup");
      const rawAction = sanitizedFilePart(this.activeClipEntry?.name || this.activeClipEntry?.id, "animation");
      let action = rawAction.replace(/-clean$/i, "");
      if (action.toLowerCase().startsWith(`${actor.toLowerCase()}-`)) {
        action = action.slice(actor.length + 1);
      }
      return `${actor}-${action || "animation"}-clean`;
    },

    selectedLibraryFileMatchesActiveClip(item) {
      if (!item || !this.activeClipEntry) {
        return true;
      }
      const active = this.activeClipEntry;
      return Boolean(
        (item.key && active.libraryKey === item.key)
        || (item.path && active.libraryPath === item.path)
        || (item.url && active.url === item.url)
      );
    },

    async ensureSelectedLibraryActionLoadedForExport() {
      const item = this.selectedAnimationLibraryFile?.();
      if (!item || this.selectedLibraryFileMatchesActiveClip(item)) {
        return;
      }
      await this.loadAnimationLibraryAsset?.(item);
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

    exportAnimatedObjects({ customOnly = false } = {}) {
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
      for (const bone of this.bones?.values?.() || []) {
        if (customOnly && !this.customBoneRecord?.(bone.name)) {
          continue;
        }
        addObject(bone);
      }
      return objects;
    },

    exportMaterials() {
      const materials = new Set();
      this.model?.traverse?.((object) => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material) {
            materials.add(material);
          }
        }
      });
      return [...materials];
    },

    shouldExcludeObjectFromAssetExport(object) {
      if (!object?.isMesh || object.isSkinnedMesh) {
        return false;
      }
      if (object.userData?.exportExclude || object.userData?.editorOnly) {
        return true;
      }
      const materials = (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean);
      return materials.length === 0;
    },

    removeNonExportableObjectsForAssetExport() {
      const removed = [];
      this.model?.traverse?.((object) => {
        if (!this.shouldExcludeObjectFromAssetExport(object)) {
          return;
        }
        const parent = object.parent;
        if (!parent) {
          return;
        }
        removed.push({ object, parent, index: parent.children.indexOf(object) });
      });
      for (const item of removed) {
        item.parent.remove(item.object);
      }
      return removed;
    },

    restoreNonExportableObjectsForAssetExport(removed = []) {
      for (const item of removed.slice().reverse()) {
        if (!item.parent || item.object.parent === item.parent) {
          continue;
        }
        const index = Math.max(0, Math.min(item.index, item.parent.children.length));
        item.parent.add(item.object);
        const currentIndex = item.parent.children.indexOf(item.object);
        if (currentIndex >= 0 && currentIndex !== index) {
          item.parent.children.splice(currentIndex, 1);
          item.parent.children.splice(index, 0, item.object);
        }
      }
    },

    captureFbxRotationMetadataState() {
      const keys = ["preRotation", "postRotation", "rotationOffset", "rotationPivot", "scalingPivot", "pivot", "fbxRotationOrder", "rotationOrder"];
      const objects = [];
      this.model?.traverse?.((object) => {
        if (!object?.userData) {
          return;
        }
        const values = {};
        let hasValue = false;
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(object.userData, key)) {
            values[key] = object.userData[key];
            delete object.userData[key];
            hasValue = true;
          }
        }
        if (hasValue) {
          objects.push({ object, values });
        }
      });
      return { keys, objects };
    },

    restoreFbxRotationMetadataState(state) {
      for (const entry of state?.objects || []) {
        if (!entry.object?.userData) {
          continue;
        }
        for (const key of state.keys || []) {
          delete entry.object.userData[key];
        }
        Object.assign(entry.object.userData, entry.values || {});
      }
    },

    captureExportMaterialState() {
      return this.exportMaterials().map((material) => ({
        material,
        userData: material.userData,
        textures: EXPORT_TEXTURE_FIELDS.map((field) => ({
          field,
          texture: material[field],
          userData: material[field]?.userData,
          image: material[field]?.image
        }))
      }));
    },

    textureHasExportableImage(texture) {
      const image = texture?.image || texture?.source?.data || null;
      if (!image) {
        return false;
      }
      if (image.data !== undefined && image.width && image.height) {
        return true;
      }
      return Boolean(image.width && image.height);
    },

    textureCanvasFromGpu(texture) {
      if (!texture || !this.renderer || !THREE.WebGLRenderTarget || !this.textureAirbrushCopyTextureToTarget || !this.textureAirbrushCanvasFromRenderTarget) {
        return null;
      }
      const size = this.textureAirbrushRenderTargetSizeForTexture?.(texture) || { width: 1024, height: 1024 };
      const width = Math.max(1, Math.min(4096, Math.round(size.width || 1024)));
      const height = Math.max(1, Math.min(4096, Math.round(size.height || 1024)));
      const target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false
      });
      this.textureAirbrushCopyTextureRenderSettings?.(target.texture, texture);
      try {
        if (!this.textureAirbrushCopyTextureToTarget(texture, target)) {
          return null;
        }
        return this.textureAirbrushCanvasFromRenderTarget({ target, width, height })?.canvas || null;
      } finally {
        target.dispose();
      }
    },

    prepareTextureForAssetExport(material, field, format) {
      let texture = material?.[field];
      if (!texture) {
        return;
      }
      if (
        field === "map"
        && material.userData?.clonePaintCanvas
        && material.userData?.clonePaintTexture === material.map
      ) {
        texture = material.map;
      }
      if (!texture.image && texture.source?.data) {
        texture.image = texture.source.data;
      }
      if (!this.textureHasExportableImage(texture)) {
        const canvas = this.textureCanvasFromGpu(texture);
        if (canvas) {
          texture.image = canvas;
          texture.needsUpdate = true;
        }
      }
      if (format === "glb") {
        if (!this.textureHasExportableImage(texture)) {
          material[field] = null;
          material.needsUpdate = true;
          return;
        }
        texture.userData = {};
        return;
      }
      const textureName = sanitizedFilePart(texture.name || material.name || field || "texture", "texture");
      const existingContent = textureUserDataBytes(texture);
      const existingMimeType = texture.userData?.mimeType || texture.userData?.mediaType || texture.userData?.contentType || "";
      if (format === "fbx" && existingContent && !material.userData?.textureAirbrushBakedTexture) {
        const extension = textureExtensionForMime(existingMimeType);
        const fileName = texture.userData?.fileName || `${textureName}.${extension}`;
        texture.userData = {
          ...(texture.userData || {}),
          content: existingContent,
          fileName,
          relativeFileName: texture.userData?.relativeFileName || fileName,
          mimeType: existingMimeType || (extension === "jpg" ? "image/jpeg" : "image/png")
        };
        return;
      }
      const fileName = `${textureName}.png`;
      let canvas = texture.image || texture.source?.data;
      if (format === "fbx" && typeof canvas?.toDataURL !== "function") {
        const gpuCanvas = this.textureCanvasFromGpu(texture);
        if (gpuCanvas) {
          canvas = gpuCanvas;
          texture.image = gpuCanvas;
          texture.needsUpdate = true;
        }
      }
      const dataUrl = typeof canvas?.toDataURL === "function" ? canvas.toDataURL("image/png") : "";
      const content = dataUrlBytes(dataUrl);
      texture.userData = {
        ...(texture.userData || {}),
        ...(dataUrl ? { src: dataUrl } : {}),
        ...(content ? { content } : {}),
        fileName,
        relativeFileName: fileName,
        mimeType: texture.userData?.mimeType || "image/png"
      };
    },

    prepareMaterialsForAssetExport({ format = "fbx" } = {}) {
      for (const material of this.exportMaterials()) {
        for (const field of EXPORT_TEXTURE_FIELDS) {
          this.prepareTextureForAssetExport(material, field, format);
        }

        const cleanMaterialUserData = { ...(material.userData || {}) };
        delete cleanMaterialUserData.clonePaintCanvas;
        delete cleanMaterialUserData.clonePaintContext;
        delete cleanMaterialUserData.clonePaintTexture;
        delete cleanMaterialUserData.clonePaintTextureScale;
        delete cleanMaterialUserData.textureAirbrushBakedTexture;
        delete cleanMaterialUserData.textureAirbrushGpuTarget;
        material.userData = cleanMaterialUserData;
      }
    },

    bakePendingTextureAirbrushTargetsForExport() {
      if (typeof this.textureAirbrushCanvasFromRenderTarget !== "function") {
        return 0;
      }
      let baked = 0;
      for (const material of this.exportMaterials()) {
        const targetEntry = material?.userData?.textureAirbrushGpuTarget;
        if (!targetEntry?.target?.texture) {
          continue;
        }
        const editable = this.textureAirbrushCanvasFromRenderTarget(targetEntry);
        if (!editable?.canvas || !editable?.context) {
          continue;
        }
        const texture = new THREE.CanvasTexture(editable.canvas);
        texture.name = `${targetEntry.target.texture.name || material.map?.name || "texture"} export bake`;
        this.textureAirbrushCopyTextureRenderSettings?.(texture, targetEntry.target.texture);
        texture.userData = {
          ...(targetEntry.target.texture.userData || {}),
          mimeType: "image/png",
          width: editable.canvas.width,
          height: editable.canvas.height
        };
        material.map = texture;
        material.needsUpdate = true;
        material.userData.clonePaintCanvas = editable.canvas;
        material.userData.clonePaintContext = editable.context;
        material.userData.clonePaintTexture = texture;
        material.userData.clonePaintTextureScale = targetEntry.sourceTexture?.userData?.clonePaintTextureScale || 1;
        material.userData.textureAirbrushBakedTexture = texture;
        targetEntry.target?.dispose?.();
        delete material.userData.textureAirbrushGpuTarget;
        baked += 1;
      }
      if (baked > 0) {
        this.textureAirbrushGpuProxies?.clear?.();
      }
      return baked;
    },

    restoreExportMaterialState(states = []) {
      for (const state of states) {
        state.material.userData = state.userData || {};
        for (const textureState of state.textures || []) {
          state.material[textureState.field] = textureState.texture || null;
          if (textureState.texture) {
            textureState.texture.userData = textureState.userData || {};
            textureState.texture.image = textureState.image || null;
          }
        }
      }
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

    cloneObjectForAssetExport() {
      if (!this.model) {
        return null;
      }
      const clone = typeof SkeletonUtils?.clone === "function"
        ? SkeletonUtils.clone(this.model)
        : this.model.clone(true);
      clone.traverse?.((object) => {
        if (!object.material) {
          return;
        }
        const cloneMaterial = (material) => {
          const cloned = material.clone();
          for (const field of EXPORT_TEXTURE_FIELDS) {
            if (material[field]?.clone) {
              cloned[field] = material[field].clone();
            }
          }
          return cloned;
        };
        object.material = Array.isArray(object.material)
          ? object.material.map(cloneMaterial)
          : cloneMaterial(object.material);
      });
      clone.updateMatrixWorld(true);
      return clone;
    },

    canReuseSourceClipForExport() {
      return this.actorTarget?.mode !== "bird-flap"
        && Boolean(this.activeClipEntry?.clip)
        && !this.manualPose?.size
        && !(
          this.poseKeyframeMode === "replace"
          && this.poseKeyframes.size > 0
          && !this.poseKeyframesGenerated
        );
    },

    animationClipForExport({ forceBake = false, trackNameForObject = null } = {}) {
      if (!forceBake && this.canReuseSourceClipForExport()) {
        const sourceClip = this.activeClipEntry.clip.clone();
        sourceClip.name = `${this.activeClipEntry?.name || this.activeClipEntry?.id || "Cleaned Animation"} Clean`;
        const customObjects = this.exportAnimatedObjects({ customOnly: true });
        if (!customObjects.length) {
          return sourceClip;
        }
        const customClip = this.bakeCurrentAnimationClipForExport({ objects: customObjects, trackNameForObject });
        if (!customClip?.tracks?.length) {
          return sourceClip;
        }
        const sourceTrackNames = new Set(sourceClip.tracks.map((track) => track.name));
        sourceClip.tracks = [
          ...sourceClip.tracks,
          ...customClip.tracks.filter((track) => !sourceTrackNames.has(track.name))
        ];
        return sourceClip;
      }
      return this.bakeCurrentAnimationClipForExport({ trackNameForObject });
    },

    bakeCurrentAnimationClipForExport({ objects = null, trackNameForObject = null } = {}) {
      if (!this.model) {
        return null;
      }
      const animatedObjects = objects || this.exportAnimatedObjects();
      if (!animatedObjects.length) {
        return null;
      }
      const frameCount = this.exportTimelineFrameCount();
      const duration = this.exportAnimationDurationSeconds();
      const times = new Float32Array(frameCount + 1);
      for (let frame = 0; frame <= frameCount; frame += 1) {
        times[frame] = (frame / frameCount) * duration;
      }

      const samples = new Map(animatedObjects.map((object) => [object.uuid, {
        object,
        trackPrefix: typeof trackNameForObject === "function"
          ? trackNameForObject(object)
          : object.uuid,
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
      const vectorTrackVaries = (values, stride, fallback) => {
        const epsilon = 1e-7;
        const base = fallback || Array.from(values.slice(0, stride));
        for (let offset = 0; offset < values.length; offset += stride) {
          for (let channel = 0; channel < stride; channel += 1) {
            if (Math.abs(values[offset + channel] - base[channel]) > epsilon) {
              return true;
            }
          }
        }
        return false;
      };
      for (const sample of samples.values()) {
        const prefix = sample.trackPrefix || sample.object.uuid;
        if (vectorTrackVaries(sample.positions, 3)) {
          tracks.push(new THREE.VectorKeyframeTrack(`${prefix}.position`, times, sample.positions));
        }
        if (vectorTrackVaries(sample.quaternions, 4)) {
          tracks.push(new THREE.QuaternionKeyframeTrack(`${prefix}.quaternion`, times, sample.quaternions));
        }
        if (vectorTrackVaries(sample.scales, 3, [1, 1, 1])) {
          tracks.push(new THREE.VectorKeyframeTrack(`${prefix}.scale`, times, sample.scales));
        }
      }
      const name = this.activeClipEntry?.name || this.activeClipEntry?.id || "Cleaned Animation";
      return new THREE.AnimationClip(`${name} Clean`, duration, tracks);
    },

    async withPreparedAssetExport(format, callback) {
      const state = this.captureExportEditorState();
      let materialState = [];
      let objectState = [];
      let fbxRotationMetadataState = null;
      try {
        this.setPlayback?.(false);
        this.resetRootMotionPreview?.({ clearProfile: true });
        this.flushTextureAirbrushGpuTargetsToCanvases?.();
        this.bakePendingTextureAirbrushTargetsForExport();
        objectState = this.removeNonExportableObjectsForAssetExport();
        materialState = this.captureExportMaterialState();
        this.prepareMaterialsForAssetExport({ format });
        if (format === "fbx") {
          fbxRotationMetadataState = this.captureFbxRotationMetadataState();
        }
        const bakedClip = this.animationClipForExport({
          forceBake: false,
          trackNameForObject: (object) => object.name || object.uuid
        });
        this.resetPose();
        this.lastClipSampleTime = null;
        this.model.updateMatrixWorld(true);
        const exportObject = this.cloneObjectForAssetExport();
        this.restoreExportEditorState(state);
        return await callback({
          object3D: exportObject || this.model,
          animations: bakedClip ? [bakedClip] : [],
          frameRate: this.exportFrameRate()
        });
      } finally {
        this.restoreFbxRotationMetadataState(fbxRotationMetadataState);
        this.restoreExportMaterialState(materialState);
        this.restoreNonExportableObjectsForAssetExport(objectState);
        this.restoreExportEditorState(state);
      }
    },

    async bakeFbxExportBytes() {
      return this.withPreparedAssetExport("fbx", async (prepared) => {
        const warnings = [];
        const bytes = exportCharacterFbx(prepared, {
          embedTextures: true,
          textureTransformMode: "blender",
          bakeAnimations: false,
          warnings,
          onWarning: (warning) => console.warn("FBX export warning", warning)
        });

        return { bytes, warnings };
      });
    },

    async bakeGlbExportBytes() {
      return this.withPreparedAssetExport("glb", async (prepared) => {
        const exporter = new GLTFExporter();
        const result = await exporter.parseAsync(prepared.object3D, {
          binary: true,
          animations: prepared.animations,
          onlyVisible: false,
          includeCustomExtensions: false,
          truncateDrawRange: false
        });
        return result instanceof ArrayBuffer
          ? new Uint8Array(result)
          : ArrayBuffer.isView(result)
            ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
            : new TextEncoder().encode(String(result || ""));
      });
    },

    async exportGlbAsset() {
      if (!this.model) {
        this.setStatus("Load a model before exporting");
        return false;
      }
      try {
        this.setStatus("Baking GLB export");
        const result = await this.bakeGlbExportBytes();
        const fileName = `${this.exportFileBaseName()}.glb`;
        const blob = blobFromExportResult(result, "model/gltf-binary");
        const mode = await this.downloadExportBlob(blob, fileName, "Binary glTF", {
          "model/gltf-binary": [".glb"]
        });
        this.setStatus(`${mode === "file" ? "Saved" : "Downloaded"} ${fileName}`);
        return true;
      } catch (error) {
        console.warn("Could not export GLB", error);
        const detail = error?.message ? `: ${error.message}` : "";
        this.setStatus(error?.name === "AbortError" ? "GLB export cancelled" : `Could not export GLB${detail}`);
        return false;
      }
    },

    async exportFbxAsset() {
      if (!this.model) {
        this.setStatus("Load a model before exporting");
        return false;
      }
      try {
        this.setStatus("Baking FBX export");
        const { bytes, warnings } = await this.bakeFbxExportBytes();
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
        const detail = error?.message ? `: ${error.message}` : "";
        this.setStatus(error?.name === "AbortError" ? "FBX export cancelled" : `Could not export FBX${detail}`);
        return false;
      }
    },

    async saveAssetBytesToLibrary({ extension, label, bake }) {
      if (!this.model) {
        this.setStatus(`Load a model before saving ${label}`);
        return false;
      }
      const folder = this.selectedAnimationLibraryFolderName?.()
        || this.actorTarget?.libraryFolder
        || this.actorTarget?.animationLibraryFolder
        || "";
      if (!folder) {
        this.setStatus(`Choose an animation library folder before saving ${label}`);
        return false;
      }
      try {
        const fileName = `${this.exportFileBaseName()}.${extension}`;
        this.setStatus(`Saving ${fileName} to ${folder}...`);
        const result = await bake();
        const bytes = result?.bytes || result;
        const warnings = result?.warnings || [];
        if (this.animationLibraryStorageMode === "browser" && typeof this.uploadAnimationLibraryBlob === "function") {
          await this.uploadAnimationLibraryBlob({
            folderName: folder,
            fileName,
            blob: blobFromExportResult(bytes, extension === "glb" ? "model/gltf-binary" : "application/octet-stream")
          });
          await this.refreshAnimationLibrary?.({ silent: true });
          const warningText = warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "";
          this.setStatus(`Saved ${fileName} to browser project${warningText}`);
          return true;
        }
        const response = await fetch("/api/animation-library/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder,
            fileName,
            contentBase64: bytesToBase64(bytes)
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        await this.refreshAnimationLibrary?.({ silent: true });
        const warningText = warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "";
        this.setStatus(`Saved ${payload.file?.name || fileName} to ${folder}${warningText}`);
        return true;
      } catch (error) {
        console.warn(`Could not save ${label}`, error);
        const detail = error?.message ? `: ${error.message}` : "";
        this.setStatus(`Could not save ${label}${detail}`);
        return false;
      }
    },

    async saveFbxAssetToLibrary() {
      return this.saveAssetBytesToLibrary({
        extension: "fbx",
        label: "FBX",
        bake: () => this.bakeFbxExportBytes()
      });
    },

    async saveGlbAssetToLibrary() {
      return this.saveAssetBytesToLibrary({
        extension: "glb",
        label: "GLB",
        bake: () => this.bakeGlbExportBytes()
      });
    }
  });
}
