const PREVIEW_SCALE_MULTIPLIER_MIN = 0.0005;
const PREVIEW_SCALE_MULTIPLIER_MAX = 1.6;
const PREVIEW_SCALE_CONTROL_STEP = 0.01;
const PREVIEW_SCALE_CONTROL_MIN = -3.3;
const PREVIEW_SCALE_CONTROL_MAX = Math.log10(PREVIEW_SCALE_MULTIPLIER_MAX);
const CLIP_GROUND_OFFSET_EPSILON = 0.0001;
const CLIP_GROUND_SAMPLE_COUNT = 17;
const CLIP_GROUND_MAX_VERTICES_PER_MESH = 12000;
const CLIP_ORIENTATION_EPSILON = 0.0001;
const CLIP_SIDEWAYS_AXIS_RATIO = 1.2;

function animationFileBaseName(value) {
  return String(value || "")
    .split("?")[0]
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "") || "";
}

function animationFileExtension(value) {
  return String(value || "")
    .split("?")[0]
    .split(".")
    .pop()
    ?.toLowerCase() || "";
}

function animationActionIdFromFileName(value) {
  return animationFileBaseName(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .toLowerCase();
}

function animationLabelFromFileName(value) {
  const base = animationFileBaseName(value);
  if (!base) {
    return "Animation";
  }
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function embeddedPngDimensions(bytes, offset) {
  if (offset + 24 > bytes.length) {
    return null;
  }
  return {
    width: (
      (bytes[offset + 16] << 24)
      | (bytes[offset + 17] << 16)
      | (bytes[offset + 18] << 8)
      | bytes[offset + 19]
    ) >>> 0,
    height: (
      (bytes[offset + 20] << 24)
      | (bytes[offset + 21] << 16)
      | (bytes[offset + 22] << 8)
      | bytes[offset + 23]
    ) >>> 0
  };
}

function embeddedJpegDimensions(bytes, offset, end) {
  let cursor = offset + 2;
  while (cursor < end - 9) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    while (bytes[cursor] === 0xff) {
      cursor += 1;
    }
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    if (cursor + 2 > end) {
      return null;
    }
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > end) {
      return null;
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: (bytes[cursor + 3] << 8) | bytes[cursor + 4],
        width: (bytes[cursor + 5] << 8) | bytes[cursor + 6]
      };
    }
    cursor += length;
  }
  return null;
}

function sortEmbeddedTexturePayloads(payloads) {
  return [...payloads].sort((a, b) => {
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    return (areaB - areaA) || (b.content.byteLength - a.content.byteLength);
  });
}

function extractEmbeddedTexturePayloads(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  const images = [];
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const matchesAt = (index, signature) => signature.every((value, offset) => bytes[index + offset] === value);
  for (let index = 0; index < bytes.length - 8; index += 1) {
    if (matchesAt(index, pngSignature)) {
      for (let cursor = index + 8; cursor < bytes.length - 12;) {
        const length = (
          (bytes[cursor] << 24)
          | (bytes[cursor + 1] << 16)
          | (bytes[cursor + 2] << 8)
          | bytes[cursor + 3]
        ) >>> 0;
        const type = String.fromCharCode(bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7]);
        cursor += 12 + length;
        if (type === "IEND" && cursor <= bytes.length) {
          const imageBytes = bytes.subarray(index, cursor);
          const content = imageBytes.slice();
          const dimensions = embeddedPngDimensions(bytes, index);
          images.push({
            content,
            mimeType: "image/png",
            src: `data:image/png;base64,${bytesToBase64(imageBytes)}`,
            fileName: `embedded-texture-${images.length + 1}.png`,
            width: dimensions?.width || 0,
            height: dimensions?.height || 0
          });
          index = cursor - 1;
          break;
        }
      }
    } else if (bytes[index] === 0xff && bytes[index + 1] === 0xd8 && bytes[index + 2] === 0xff) {
      for (let cursor = index + 2; cursor < bytes.length - 1; cursor += 1) {
        if (bytes[cursor] === 0xff && bytes[cursor + 1] === 0xd9) {
          const imageBytes = bytes.subarray(index, cursor + 2);
          const dimensions = embeddedJpegDimensions(bytes, index, cursor + 2);
          if (!dimensions?.width || !dimensions?.height) {
            index = cursor + 1;
            break;
          }
          const content = imageBytes.slice();
          images.push({
            content,
            mimeType: "image/jpeg",
            src: `data:image/jpeg;base64,${bytesToBase64(imageBytes)}`,
            fileName: `embedded-texture-${images.length + 1}.jpg`,
            width: dimensions.width,
            height: dimensions.height
          });
          index = cursor + 1;
          break;
        }
      }
    }
  }
  return sortEmbeddedTexturePayloads(images);
}

async function imageFromDataUrl(src) {
  if (typeof Image === "undefined" || !src) {
    return null;
  }
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  try {
    if (typeof image.decode === "function") {
      await image.decode();
    } else if (!image.complete) {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
    }
  } catch (error) {
    console.warn("Could not decode embedded FBX texture", error);
    return null;
  }
  return image;
}

function formatPreviewScaleMultiplier(value) {
  if (value < 0.01) {
    return value.toFixed(4);
  }
  if (value < 0.1) {
    return value.toFixed(3);
  }
  return value.toFixed(2);
}

export function installActorAndModelMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    OrbitControls,
    TransformControls,
    cloneClipWithStartDeleted,
    cloneClipWithStartOffsetApplied,
    configuredClipStartOffsetSeconds,
    remainingClipStartOffsetSeconds,
    loadBirdFlapProfile,
    BIRD_WEIGHT_PATCH_FILE_NAME,
    ACTOR_TARGETS,
    WING_BONES,
    BODY_BONES,
    PREVIEW_PARAMS,
    BASE_COLOR,
    SELECTED_COLOR,
    MODIFIED_COLOR,
    SELECTED_MODIFIED_COLOR,
    CURVE_CHANNELS,
    CURVE_CHANNEL_KEYS,
    ADDITIVE_POSE_EASE_FRAMES,
    RIG_BONE_GROUPS,
    EDIT_ONLY_TOOLS,
    finitePoseValue,
    writeJsonFile,
    writeAnimationLibraryCleanupFile
  } = deps;
  Object.assign(BirdWeightEditor.prototype, {
    renderCharacterOptions() {
      if (!this.characterSelect) {
        return;
      }
      const targetsById = new Map();
      for (const target of ACTOR_TARGETS) {
        targetsById.set(target.id, target);
      }
      for (const folder of this.animationLibraryFolders || []) {
        const target = this.animationLibraryTargetForFolder(folder.name);
        if (target) {
          targetsById.set(target.id, target);
        }
      }
      if (this.actorTarget?.id && !targetsById.has(this.actorTarget.id)) {
        targetsById.set(this.actorTarget.id, this.actorTarget);
      }
      const targets = [...targetsById.values()];
      this.characterSelect.replaceChildren(
        ...targets.map((target) => {
          const option = document.createElement("option");
          option.value = target.id;
          option.textContent = target.label;
          return option;
        })
      );
      this.characterSelect.value = this.actorTarget.id;
    },

    renderActionOptions() {
      if (!this.actionSelect) {
        return;
      }
      const actionEntries = this.availableActionEntries();
      const options = actionEntries.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.id || entry.name;
        option.textContent = entry.name || entry.label || entry.id;
        option.disabled = entry.available === false;
        return option;
      });
      this.actionSelect.replaceChildren(
        ...options.map((option) => option.cloneNode(true))
      );
      if (this.timelineBlendActionSelect) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "None";
        this.timelineBlendActionSelect.replaceChildren(
          none,
          ...options.map((option) => {
            const clone = option.cloneNode(true);
            if (clone.value === (this.activeClipEntry?.id || this.activeClipEntry?.name)) {
              clone.disabled = true;
            }
            return clone;
          })
        );
      }
      const activeId = this.activeClipEntry?.id || this.activeClipEntry?.name || this.actionSelect.value || this.actionSelect.options[0]?.value || "";
      if (activeId) {
        this.actionSelect.value = activeId;
      }
      this.sanitizeBlendSelection();
      this.syncBlendControls();
      this.syncClipCleanupControls();
    },

    animationLibraryActionEntries() {
      const libraryFolderName = this.selectedLibraryCharacterFolderName?.()
        || this.actorTarget?.libraryFolder
        || this.actorTarget?.animationLibraryFolder
        || "";
      const libraryFolder = libraryFolderName
        ? this.animationLibraryFolders?.find((folder) => folder.name === libraryFolderName)
        : null;
      const libraryFiles = libraryFolder?.files?.filter((file) => file.available !== false) || [];
      if (!libraryFiles.length || typeof this.animationLibraryClipEntryForItem !== "function") {
        return [];
      }
      return libraryFiles.map((file) => {
        const entry = this.animationLibraryClipEntryForItem({
          ...file,
          folder: file.folder || libraryFolderName
        });
        const existing = this.clipEntries.find((clip) => (
          (entry.id && (clip.id || clip.name) === entry.id)
          || (entry.libraryKey && clip.libraryKey === entry.libraryKey)
          || (entry.libraryPath && clip.libraryPath === entry.libraryPath)
        ));
        return existing || entry;
      });
    },

    availableActionEntries() {
      const libraryEntries = this.animationLibraryActionEntries();
      return libraryEntries.length ? libraryEntries : this.clipEntries;
    },

    availableBlendEntries() {
      const activeId = this.activeClipEntry?.id || this.activeClipEntry?.name || "";
      return this.availableActionEntries().filter((entry) => (
        entry.available !== false
        && (entry.id || entry.name)
        && (entry.id || entry.name) !== activeId
      ));
    },

    findAvailableActionEntry(actionId) {
      if (!actionId) {
        return null;
      }
      return this.availableActionEntries().find((clip) => (
        (clip.id || clip.name) === actionId
        && clip.available !== false
      )) || null;
    },

    sanitizeBlendSelection() {
      const activeId = this.activeClipEntry?.id || this.activeClipEntry?.name || "";
      const blendEntries = this.availableBlendEntries();
      if (this.actorTarget?.mode === "bird-flap" || !blendEntries.length || !this.blendActionId || this.blendActionId === activeId) {
        this.blendActionId = "";
        this.blendClipEntry = null;
        this.blendClipAction?.stop();
        this.blendClipAction = null;
        return;
      }
      const entry = this.findAvailableActionEntry(this.blendActionId);
      if (!entry) {
        this.blendActionId = "";
        this.blendClipEntry = null;
        this.blendClipAction?.stop();
        this.blendClipAction = null;
      }
    },

    syncBlendControls() {
      const disabled = this.actorTarget?.mode === "bird-flap" || !this.availableBlendEntries().length;
      if (this.timelineBlendActionSelect) {
        this.timelineBlendActionSelect.disabled = disabled;
        this.timelineBlendActionSelect.value = disabled ? "" : this.blendActionId;
      }
      if (this.timelineBlendControl) {
        this.timelineBlendControl.disabled = this.actorTarget?.mode === "bird-flap";
      }
      if (this.timelinePlayBothButton) {
        this.timelinePlayBothButton.disabled = disabled || !this.blendActionId;
      }
      if (this.transferCleanupToBlendButton) {
        this.transferCleanupToBlendButton.disabled = disabled || !this.blendActionId;
      }
      this.app?.classList.toggle("has-blend-target", !disabled && Boolean(this.blendActionId));
      this.updateBlendOutput();
      this.syncSequenceControls();
    },

    updateBlendOutput() {
      if (this.timelineBlendOutput && this.timelineBlendControl) {
        this.timelineBlendOutput.textContent = `${this.currentBlendSeconds().toFixed(2)}s`;
      }
    },

    currentBlendSeconds() {
      return THREE.MathUtils.clamp(Number(this.timelineBlendControl?.value) || 0.35, 0.05, 2);
    },

    async selectBlendAction(actionId) {
      this.blendActionId = actionId || "";
      this.sanitizeBlendSelection();
      const entry = this.findAvailableActionEntry(this.blendActionId);
      this.blendClipEntry = entry || null;
      this.blendClipAction?.stop();
      this.blendClipAction = null;
      this.syncBlendControls();
      if (!entry) {
        this.stopSequencePreview({ applyPose: true, resetElapsed: true });
        return;
      }
      try {
        if (!entry.clip) {
          entry.clip = await this.loadClipForEntry(entry);
        }
        this.blendClipEntry = entry;
        this.syncBlendControls();
        this.setStatus(`Blending to ${entry.name || entry.id}`);
      } catch (error) {
        console.error(error);
        this.blendActionId = "";
        this.blendClipEntry = null;
        this.blendClipAction = null;
        this.syncBlendControls();
        this.setStatus("Could not load blend clip");
      }
    },

    async selectClipAction(actionId) {
      this.stopSequencePreview({ applyPose: false, resetElapsed: true });
      this.pausePlayback?.();
      const previousActionId = this.activeClipEntry?.id || this.activeClipEntry?.name || "";
      const entry = this.clipEntries.find((clip) => (clip.id || clip.name) === actionId && clip.available !== false)
        || this.clipEntries.find((clip) => clip.available !== false)
        || this.clipEntries[0]
        || null;
      if (!entry) {
        return;
      }
      const hidePreviewDuringLoad = this.actorTarget?.mode !== "bird-flap" && this.modelRoot;
      if (hidePreviewDuringLoad) {
        this.modelRoot.visible = false;
        if (this.skeletonHelper) {
          this.skeletonHelper.visible = false;
        }
      }
      try {
        const nextActionId = entry.id || entry.name || "";
        if (previousActionId && previousActionId !== nextActionId) {
          this.poseKeyframes.clear();
          this.manualPose.clear();
          this.poseKeyframeMode = "additive";
          this.poseKeyframesGenerated = false;
          this.clipCleanupEdits.clear();
        }
        this.activeClipEntry = entry;
        this.progress = 0;
        this.timeScrub.value = "0";
        if (this.timelineScrub) {
          this.timelineScrub.value = "0";
        }
        if (this.actorTarget?.mode !== "bird-flap") {
          await this.loadAnimationLibraryCleanupForEntry(entry, { silent: true });
          await this.playClipEntry(entry);
        }
        const autoKeyed = await this.autoKeyClipOnLoadIfNeeded?.({ silent: true });
        this.renderActionOptions();
        this.applyPose(0);
        this.updateSkeletonHelper();
        this.syncTimelineControls();
        this.syncPoseControlsToCurrentBone();
        this.setStatus(autoKeyed
          ? this.autoKeyStatusText?.(autoKeyed, autoKeyed.label) || `Auto-keyed ${autoKeyed.label}: ${autoKeyed.curveKeyCount} curve keys, ${autoKeyed.frames.length} frames, ${autoKeyed.boneNames.length} bones`
          : `Editing ${entry.name || entry.id}`);
      } finally {
        if (hidePreviewDuringLoad) {
          this.modelRoot.visible = true;
        }
      }
    },

    async selectActor(actorId, options = {}) {
      const autoLoadLibrary = options.autoLoadLibrary !== false;
      if (String(actorId || "").startsWith("library:")) {
        const folderName = String(actorId).slice("library:".length);
        const nextTarget = this.animationLibraryTargetForFolder(folderName);
        if (nextTarget) {
          this.actorTarget = nextTarget;
          if (this.characterSelect && this.characterSelect.value !== nextTarget.id) {
            this.characterSelect.value = nextTarget.id;
          }
          this.animationLibrarySelectedFolder = folderName;
          this.renderAnimationLibrary?.();
          this.renderCharacterOptions();
          this.clearActorModel();
          this.renderActionOptions();
          this.syncTimelineControls();
          this.source.textContent = `Library: ${folderName}`;
          if (autoLoadLibrary) {
            const loaded = await this.loadSelectedAnimationLibraryFile?.();
            if (!loaded) {
              this.setStatus("Choose an animation folder and import an FBX or GLB at the bottom first");
            }
          } else {
            this.setStatus("Choose an animation");
          }
          return;
        }
      }
      const nextTarget = ACTOR_TARGETS.find((target) => target.id === actorId) || ACTOR_TARGETS[0];
      this.actorTarget = nextTarget;
      if (this.characterSelect && this.characterSelect.value !== nextTarget.id) {
        this.characterSelect.value = nextTarget.id;
      }
      if (nextTarget.animationLibraryFolder) {
        this.animationLibrarySelectedFolder = nextTarget.animationLibraryFolder;
        this.renderAnimationLibrary?.();
      }
      await this.loadActorModel(nextTarget);
    },

    async loadBirdModel() {
      await this.selectActor("bird");
    },

    clearActorModel() {
      this.pausePlayback?.();
      this.clearClonePaintState?.({ silent: true });
      this.disposeMeshWireOverlays?.();
      this.disposeSkeletonHelper?.();
      this.transformControls.detach();
      this.transformHelper.visible = false;
      this.selectionPivot.visible = false;
      this.selectionPivotMarker.visible = false;
      this.boneMoveDrag = null;
      this.mixer?.stopAllAction();
      this.mixer = null;
      this.activeClipAction = null;
      this.activeClipEntry = null;
      this.blendClipAction = null;
      this.blendClipEntry = null;
      this.blendActionId = "";
      this.sequencePlaying = false;
      this.sequenceElapsed = 0;
      this.sequenceRootAnchor = null;
      this.sequenceTargetRootStart = null;
      this.invalidateRootMotionPreviewProfile?.();
      this.clipEntries = [];
      this.clipCleanupEdits.clear();
      this.rootMotionUnbakeActions?.clear?.();
      this.lastClipSampleTime = null;
      this.poseKeyframeMode = "additive";
      this.poseKeyframesGenerated = false;
      this.birdFlapParams = { ...PREVIEW_PARAMS };
      this.birdPreviewUsesFlapParams = false;
      this.modelRoot.visible = false;
      this.modelRoot.clear();
      this.groundGrid?.position.set(0, 0, 0);
      this.groundFloor?.position.set(0, -0.012, 0);
      this.model = null;
      this.syncExportButtons?.();
      this.bindPose = [];
      this.bones.clear();
      this.paintRecords = [];
      this.manualPose.clear();
      this.poseKeyframes.clear();
      this.poseClipboard = null;
      this.poseKeyframesGenerated = false;
      this.virtualBones = [];
      this.manualBoneChains = [];
      this.undoStack = [];
      this.redoStack = [];
      this.updateUndoButton?.();
      this.syncPoseClipboardControls?.();
      this.boneLayerNames = [];
      this.bonePickerNames = [];
      this.invalidateBoneDisplayCache?.();
      this.activeBoneName = "";
      this.selectedBoneChainRootName = "";
      this.markerVertexCount = 0;
      this.vertexMarkerCount = 0;
      this.markerGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      this.markerGeometry.setAttribute("color", new THREE.Float32BufferAttribute([], 3));
      this.vertexGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      this.vertexGeometry.setAttribute("color", new THREE.Float32BufferAttribute([], 3));
      this.neighborHoverGeometry?.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      if (this.neighborHoverMarker) {
        this.neighborHoverMarker.visible = false;
      }
      this.selectedBoneLineGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      this.selectedBoneJointGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      this.bonePickerLineGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      this.bonePickerGeometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
      this.bonePickerGeometry.setAttribute("color", new THREE.Float32BufferAttribute([], 3));
      this.bonePickerLines.visible = false;
      this.bonePickerJoints.visible = false;
      this.boneLabels?.replaceChildren();
      this.updateTimelineKeyMarkers();
      this.updateCounts();
    },

    async loadActorModel(target) {
      const token = ++this.loadToken;
      try {
        this.setStatus(`Loading ${target.label}`);
        this.clearActorModel();
        if (!target?.modelUrl) {
          this.renderActionOptions();
          this.syncTimelineControls();
          this.updateTimelineKeyMarkers();
          this.syncPatchJson();
          this.source.textContent = target?.sourceLabel || "Import a raw Mixamo FBX to begin";
          this.setStatus("Import a raw Mixamo FBX to begin");
          return;
        }
        const asset = await this.loadModelAssetUrl(target.modelUrl);
        if (token !== this.loadToken || this.actorTarget.id !== target.id) {
          return;
        }
        this.model = asset.scene;
        this.syncExportButtons?.();
        this.prepareModel(this.model, target.displayHeight * (target.defaultScale || 1));
        this.baseModelScale = this.model.scale.x || 1;
        this.actorScaleMultiplier = 1;
        this.syncScaleControls();
        this.modelRoot.add(this.model);
        this.mixer = target.mode === "bird-flap" ? null : new THREE.AnimationMixer(this.model);
        this.bindPose = this.captureBindPose();
        this.collectBones();
        this.collectPaintableMeshes();
        this.populateBoneSelect();
        await this.loadPatchAsset({ silent: true });
        if (token !== this.loadToken || this.actorTarget.id !== target.id) {
          return;
        }
        if (target.id === "bird") {
          await this.loadBirdPreviewProfile({ silent: true });
          if (token !== this.loadToken || this.actorTarget.id !== target.id) {
            return;
          }
        }
        this.clipEntries = await this.clipEntriesForTarget(target, asset);
        this.applyClipCleanupToEntries();
        if (token !== this.loadToken || this.actorTarget.id !== target.id) {
          return;
        }
        this.activeClipEntry = this.clipEntries.find((entry) => entry.id === target.defaultAction && entry.available !== false)
          || this.clipEntries.find((entry) => entry.available !== false)
          || this.clipEntries[0]
          || null;
        if (this.activeClipEntry) {
          await this.loadAnimationLibraryCleanupForEntry(this.activeClipEntry, { silent: true });
          if (token !== this.loadToken || this.actorTarget.id !== target.id) {
            return;
          }
        }
        this.renderActionOptions();
        if (this.activeClipEntry) {
          await this.playClipEntry(this.activeClipEntry);
          if (token !== this.loadToken || this.actorTarget.id !== target.id) {
            return;
          }
        }
        const autoKeyed = await this.autoKeyClipOnLoadIfNeeded?.({ silent: true });
        this.setViewMode(this.viewMode, { silent: true });
        this.applyPose(0);
        this.updateSkeletonHelper();
        this.modelRoot.visible = true;
        this.restoreSavedOrbitView?.({ status: false });
        this.syncTimelineControls();
        this.updateTimelineKeyMarkers();
        this.updateBoneLabels();
        this.syncPatchJson();
        this.source.textContent = target.id === "bird" && this.birdPreviewUsesFlapParams
          ? "Weights: bird-weight-patch.json / Anim: bird-flap-params.json"
          : target.sourceLabel || target.modelUrl.replace("./assets/models/", "").replace(/\?.*$/, "");
        this.setStatus(autoKeyed
          ? this.autoKeyStatusText?.(autoKeyed, autoKeyed.label) || `Auto-keyed ${autoKeyed.label}: ${autoKeyed.curveKeyCount} curve keys, ${autoKeyed.frames.length} frames, ${autoKeyed.boneNames.length} bones`
          : "Ready");
        await this.maybeReplayClonePaintFromUrl?.();
      } catch (error) {
        console.error(error);
        this.modelRoot.visible = Boolean(this.model);
        this.setStatus(`Could not load ${target.label}`);
      }
    },

    async attachEmbeddedFbxTextures(scene, buffer) {
      const payloads = extractEmbeddedTexturePayloads(buffer);
      if (!scene || !payloads.length) {
        return 0;
      }
      const decodedImages = (await Promise.all(payloads.map((payload) => imageFromDataUrl(payload.src))))
        .map((image, index) => image ? { image, ...payloads[index] } : null)
        .filter(Boolean);
      if (!decodedImages.length) {
        return 0;
      }
      const textures = [];
      const seen = new Set();
      const textureFields = ["map", "alphaMap", "aoMap", "bumpMap", "displacementMap", "emissiveMap", "lightMap", "metalnessMap", "normalMap", "roughnessMap", "specularMap"];
      scene.traverse((object) => {
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material].filter(Boolean);
        for (const material of materials) {
          for (const field of textureFields) {
            const texture = material?.[field];
            if (!texture || seen.has(texture.uuid)) {
              continue;
            }
            seen.add(texture.uuid);
            textures.push(texture);
          }
        }
      });
      let attached = 0;
      textures.forEach((texture, index) => {
        const embedded = decodedImages[Math.min(index, decodedImages.length - 1)];
        if (!embedded) {
          return;
        }
        texture.image = embedded.image;
        texture.source.data = embedded.image;
        texture.userData = {
          ...(texture.userData || {}),
          content: embedded.content,
          mimeType: embedded.mimeType,
          width: embedded.width,
          height: embedded.height,
          fileName: embedded.fileName,
          relativeFileName: embedded.fileName
        };
        texture.needsUpdate = true;
        attached += 1;
      });
      return attached;
    },

    async loadModelAssetUrl(url) {
      const extension = animationFileExtension(url);
      if (extension === "fbx") {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const scene = this.fbxLoader.parse(buffer, "");
        await this.attachEmbeddedFbxTextures?.(scene, buffer);
        return {
          scene,
          animations: scene.animations || [],
          sourceType: "fbx"
        };
      }
      return this.loadGLTFUrl(url);
    },

    async loadBirdPreviewProfile({ silent = false } = {}) {
      try {
        const profile = await loadBirdFlapProfile();
        this.birdFlapParams = { ...PREVIEW_PARAMS, ...profile.params };
        this.birdPreviewUsesFlapParams = true;
        if (profile.poseKeyframes?.size) {
          this.applyPoseKeyframeMap(profile.poseKeyframes);
        }
        if (!silent) {
          this.setStatus("Loaded bird-flap-params.json preview");
        }
      } catch (error) {
        this.birdFlapParams = { ...PREVIEW_PARAMS };
        this.birdPreviewUsesFlapParams = false;
        if (!silent) {
          this.setStatus("Could not load bird-flap-params.json preview");
        }
        console.warn("Could not load bird-flap-params.json preview", error);
      }
    },

    async clipEntriesForTarget(target, gltf) {
      if (target.mode === "embedded-clips") {
        return (gltf.animations || []).map((clip, index) => ({
          id: clip.name || target.defaultAction || `clip-${index + 1}`,
          name: clip.name || target.defaultAction || `Clip ${index + 1}`,
          sourceClip: clip.clone(),
          clip: cloneClipWithStartOffsetApplied(clip, configuredClipStartOffsetSeconds({ clip }, target)),
          startOffsetSeconds: configuredClipStartOffsetSeconds({ clip }, target)
        }));
      }
      if (target.mode === "external-clips") {
        return target.actions.map((action) => ({ ...action }));
      }
      return target.actions.map((action) => ({ ...action }));
    },

    async playClipEntry(entry) {
      if (!this.mixer || !this.model || !entry) {
        return;
      }
      if (!entry.clip) {
        entry.clip = await this.loadClipForEntry(entry);
      }
      this.mixer.stopAllAction();
      this.resetPose();
      const action = this.mixer.clipAction(entry.clip, this.model);
      action.reset();
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setLoop(this.loopToggle.checked ? THREE.LoopRepeat : THREE.LoopOnce, this.loopToggle.checked ? Infinity : 1);
      action.clampWhenFinished = !this.loopToggle.checked;
      action.play();
      this.activeClipAction = action;
      this.activeClipEntry = entry;
      this.lastClipSampleTime = null;
      this.invalidateRootMotionPreviewProfile?.();
      this.syncClipCleanupControls();
      this.syncExportButtons?.();
    },

    async loadClipForEntry(entry) {
      if (entry.clip) {
        return entry.clip;
      }
      const extension = animationFileExtension(entry.url || entry.name);
      let animations = [];
      if (extension === "fbx") {
        const response = await fetch(entry.url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const scene = this.fbxLoader.parse(buffer, "");
        await this.attachEmbeddedFbxTextures?.(scene, buffer);
        animations = scene.animations || [];
      } else {
        const gltf = await this.loadGLTFUrl(entry.url);
        animations = gltf.animations || [];
      }
      const clip = animations[0];
      if (!clip) {
        throw new Error(`No animation found in ${entry.name}`);
      }
      const clone = clip.clone();
      clone.name = entry.name || animationLabelFromFileName(entry.url);
      entry.sourceClip = clone;
      entry.startOffsetSeconds = configuredClipStartOffsetSeconds(entry, this.actorTarget);
      this.applyClipCleanupToEntry(entry);
      if (!entry.clip) {
        entry.clip = cloneClipWithStartOffsetApplied(entry.sourceClip, entry.startOffsetSeconds);
      }
      return entry.clip;
    },

    async loadImportedAnimationFile(file) {
      try {
        const buffer = await file.arrayBuffer();
        await this.loadImportedAnimationBuffer({
          buffer,
          fileName: file.name,
          sourceLabel: `Imported ${file.name}`,
          modelUrl: file.name
        });
      } catch (error) {
        console.error(error);
        this.setStatus(`Could not load ${file.name}`);
      }
    },

    async loadImportedAnimationBuffer({ buffer, fileName, sourceLabel, modelUrl = "", patchStem = "" }) {
      const token = ++this.loadToken;
      try {
        this.setStatus(`Loading ${fileName}`);
        this.clearActorModel();
        this.modelRoot.visible = false;
        const extension = fileName.split(".").pop()?.toLowerCase() || "";
        let imported;
        if (extension === "fbx") {
          const scene = this.fbxLoader.parse(buffer, "");
          await this.attachEmbeddedFbxTextures?.(scene, buffer);
          imported = { scene, animations: scene.animations || [] };
        } else {
          imported = await this.parseGLTFBuffer(buffer, "");
        }
        await this.loadImportedAnimationData({ token, imported, fileName, sourceLabel, modelUrl, patchStem });
      } catch (error) {
        console.error(error);
        this.setStatus(`Could not load ${fileName}`);
      }
    },

    animationLibraryActorTargetForFolder(folderName) {
      return null;
    },

    animationLibraryTargetForFolder(folderName) {
      const name = String(folderName || "").trim();
      if (!name) {
        return null;
      }
      const folder = this.animationLibraryFolders?.find((item) => item.name === name);
      return {
        id: `library:${name}`,
        label: folder?.label || name,
        sourceLabel: folder?.label || name,
        modelUrl: "",
        mode: "embedded-clips",
        displayHeight: this.actorTarget?.displayHeight || 1.8,
        defaultScale: 1,
        defaultAction: folder?.files?.[0]?.name ? animationActionIdFromFileName(folder.files[0].name) : "",
        actions: [],
        patchFile: BIRD_WEIGHT_PATCH_FILE_NAME,
        defaultBone: "Hips",
        animationLibraryFolder: name,
        libraryFolder: name
      };
    },

    animationLibraryClipEntryForItem(item) {
      const fileName = item.name || String(item.url || item.path || "").split("/").pop() || "animation.fbx";
      const actionId = item.actionId || animationActionIdFromFileName(fileName) || animationActionIdFromFileName(item.path) || "library-clip";
      const label = item.label || animationLabelFromFileName(fileName);
      const url = item.url || `./${item.path}`;
      return {
        id: actionId,
        name: label,
        url,
        libraryFolder: item.folder || "",
        libraryCleanupFile: item.cleanupFile || this.animationLibraryCleanupFileNameFromLabel(fileName),
        libraryCleanupUrl: item.cleanupUrl || "",
        libraryPath: item.path || "",
        libraryKey: item.key || item.path || url,
        imported: true
      };
    },

    upsertClipEntry(entry) {
      const entryId = entry.id || entry.name;
      const existingIndex = this.clipEntries.findIndex((clip) => (
        (entryId && (clip.id || clip.name) === entryId)
        || (entry.libraryKey && clip.libraryKey === entry.libraryKey)
        || (entry.libraryPath && clip.libraryPath === entry.libraryPath)
      ));
      if (existingIndex >= 0) {
        const existing = this.clipEntries[existingIndex];
        const merged = {
          ...existing,
          ...entry,
          sourceClip: existing.sourceClip,
          clip: existing.clip
        };
        this.clipEntries.splice(existingIndex, 1, merged);
        return merged;
      }
      this.clipEntries.push(entry);
      return entry;
    },

    async loadAnimationLibraryClipAsset(item, target) {
      this.pausePlayback?.();
      const previousActionId = this.activeClipEntry?.id || this.activeClipEntry?.name || "";
      this.animationLibrarySelectedFolder = item.folder || target.animationLibraryFolder || this.animationLibrarySelectedFolder;
      if (this.actorTarget?.id !== target.id || !this.model) {
        await this.selectActor(target.id, { autoLoadLibrary: false });
      }
      this.animationLibrarySelectedFolder = item.folder || target.animationLibraryFolder || this.animationLibrarySelectedFolder;
      this.renderAnimationLibrary?.();

      const entry = this.upsertClipEntry(this.animationLibraryClipEntryForItem(item));
      const nextActionId = entry.id || entry.name || "";
      if (previousActionId && previousActionId !== nextActionId) {
        this.poseKeyframes.clear();
        this.manualPose.clear();
        this.poseKeyframeMode = "additive";
        this.poseKeyframesGenerated = false;
        this.clipCleanupEdits.clear();
      }

      this.activeClipEntry = entry;
      this.progress = 0;
      if (this.timeScrub) {
        this.timeScrub.value = "0";
      }
      if (this.timelineScrub) {
        this.timelineScrub.value = "0";
      }
      await this.loadAnimationLibraryCleanupForEntry(entry, { silent: true });
      await this.playClipEntry(entry);
      this.applyPose(0);
      const autoKeyed = await this.autoKeyClipOnLoadIfNeeded?.({ silent: true });
      this.renderActionOptions();
      this.applyPose(0);
      this.updateSkeletonHelper();
      this.syncTimelineControls();
      this.syncPoseControlsToCurrentBone();
      this.updateTimelineKeyMarkers();
      this.updateBoneLabels();
      this.syncPatchJson();
      const fileName = item.name || entry.name || "animation";
      this.source.textContent = `${target.label}: ${fileName}`;
      this.setStatus(autoKeyed
        ? this.autoKeyStatusText?.(autoKeyed, entry.name) || `Auto-keyed ${entry.name}: ${autoKeyed.curveKeyCount} curve keys, ${autoKeyed.frames.length} frames, ${autoKeyed.boneNames.length} bones`
        : `Opened ${entry.name} on ${target.label}`);
      return true;
    },

    async loadAnimationLibraryAsset(item) {
      this.rememberAnimationLibraryFile?.(item);
      if (item.actorId) {
        await this.selectActor(item.actorId);
        if (item.actionId) {
          await this.selectClipAction(item.actionId);
        }
        const label = item.label || item.actionId || item.name || "animation";
        this.setStatus(`Opened ${label} from ${item.folder || "animation library"}`);
        return true;
      }

      const folderTarget = this.animationLibraryActorTargetForFolder(item.folder);
      const extension = String(item.extension || animationFileExtension(item.name || item.path || item.url)).toLowerCase();
      if (folderTarget && !item.engine && ["fbx", "glb", "gltf"].includes(extension)) {
        return this.loadAnimationLibraryClipAsset(item, folderTarget);
      }

      const token = ++this.loadToken;
      const url = item.url || `./${item.path}`;
      const fileName = item.name || url.split("/").pop() || "animation";
      try {
        this.setStatus(`Loading ${item.folder}/${fileName}`);
        this.clearActorModel();
        this.modelRoot.visible = false;
        const extension = fileName.split(".").pop()?.toLowerCase() || "";
        let imported;
        if (extension === "fbx") {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const buffer = await response.arrayBuffer();
          const scene = this.fbxLoader.parse(buffer, "");
          await this.attachEmbeddedFbxTextures?.(scene, buffer);
          imported = { scene, animations: scene.animations || [] };
        } else {
          imported = await this.loadGLTFUrl(url);
        }
        const patchStem = `${item.folder || "library"}-${fileName}`
          .replace(/\.[^.]+$/, "")
          .trim()
          .replace(/[^a-z0-9_-]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase();
        const folderName = String(item.folder || "").trim();
        const actionId = animationActionIdFromFileName(fileName) || "animation";
        return await this.loadImportedAnimationData({
          token,
          imported,
          fileName,
          sourceLabel: folderName || "Imported FBX",
          modelUrl: url,
          patchStem,
          libraryFolder: folderName,
          libraryCleanupFile: item.cleanupFile || `${patchStem}-weight-patch.json`,
          patchUrl: item.cleanupUrl || "",
          characterId: folderName ? `library:${folderName}` : "",
          clipNameOverride: actionId,
          clipIdOverride: actionId
        });
      } catch (error) {
        console.error(error);
        this.setStatus(`Could not load ${fileName}`);
        return false;
      }
    },

    async loadImportedAnimationData({
      token,
      imported,
      fileName,
      sourceLabel,
      modelUrl = "",
      patchStem = "",
      libraryFolder = "",
      libraryCleanupFile = "",
      patchUrl = "",
      characterId = "",
      clipNameOverride = "",
      clipIdOverride = ""
    }) {
      if (token !== this.loadToken) {
        return false;
      }
      this.pausePlayback?.();

      const displayHeight = this.actorTarget?.displayHeight || 1.72;
      const cleanPatchStem = patchStem || (
        fileName
          .replace(/\.[^.]+$/, "")
          .trim()
          .replace(/[^a-z0-9_-]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase()
      ) || "imported-animation";
      const label = sourceLabel || `Imported ${fileName}`;
      this.actorTarget = {
        id: characterId || `imported:${modelUrl || fileName}`,
        label,
        mode: "embedded-clips",
        modelUrl: modelUrl || fileName,
        sourceLabel: label,
        displayHeight,
        defaultScale: 1,
        defaultBone: "Hips",
        patchFile: libraryCleanupFile || `${cleanPatchStem}-weight-patch.json`,
        patchUrl,
        libraryFolder,
        libraryCleanupFile
      };
      this.renderCharacterOptions();

      this.model = imported.scene;
      this.syncExportButtons?.();
      this.prepareModel(this.model, displayHeight);
      this.baseModelScale = this.model.scale.x || 1;
      this.actorScaleMultiplier = 1;
      this.syncScaleControls();
      this.modelRoot.add(this.model);
      this.mixer = new THREE.AnimationMixer(this.model);
      this.bindPose = this.captureBindPose();
      this.collectBones();
      this.collectPaintableMeshes();
      this.populateBoneSelect();
      await this.loadPatchAsset({ silent: true });
      this.clipEntries = this.clipEntriesForImportedAnimations(imported.animations || [], fileName, {
        clipNameOverride,
        clipIdOverride
      });
      this.activeClipEntry = this.clipEntries[0] || null;
      this.renderActionOptions();
      if (this.activeClipEntry) {
        await this.playClipEntry(this.activeClipEntry);
      }
      const autoKeyed = await this.autoKeyClipOnLoadIfNeeded?.({ silent: true });
      this.setViewMode(this.viewMode, { silent: true });
      this.applyPose(0);
      this.updateSkeletonHelper();
      this.modelRoot.visible = true;
      this.frameLoadedModelInView();
      this.syncTimelineControls();
      this.updateTimelineKeyMarkers();
      this.updateBoneLabels();
      this.source.textContent = label;
      this.setStatus(autoKeyed
        ? this.autoKeyStatusText?.(autoKeyed, autoKeyed.label) || `Auto-keyed ${autoKeyed.label}: ${autoKeyed.curveKeyCount} curve keys, ${autoKeyed.frames.length} frames, ${autoKeyed.boneNames.length} bones`
        : this.activeClipEntry ? `Loaded ${label}` : `Loaded ${label} without animation clips`);
      await this.maybeReplayClonePaintFromUrl?.();
      return true;
    },

    clipEntriesForImportedAnimations(animations, fileName, options = {}) {
      return animations.map((clip, index) => {
        const fileActionId = animationActionIdFromFileName(fileName);
        const rawName = String(clip.name || "").trim();
        const genericMixamoName = !rawName || /^mixamo\.com$/i.test(rawName);
        const baseName = options.clipNameOverride
          || (genericMixamoName ? fileActionId : rawName)
          || fileActionId
          || `clip-${index + 1}`;
        const name = index === 0 ? baseName : `${baseName}-${index + 1}`;
        const idBase = options.clipIdOverride || animationActionIdFromFileName(name) || `imported-clip-${index + 1}`;
        const sourceClip = clip.clone();
        sourceClip.name = name;
        return {
          id: index === 0 ? idBase : `${idBase}-${index + 1}`,
          name,
          sourceClip,
          clip: cloneClipWithStartOffsetApplied(sourceClip, 0),
          startOffsetSeconds: 0,
          imported: true
        };
      });
    },

    clipFrameRate(clip) {
      const deltas = [];
      for (const track of clip?.tracks || []) {
        const times = track.times || [];
        for (let index = 1; index < times.length; index += 1) {
          const delta = times[index] - times[index - 1];
          if (delta > 0.0001 && delta < 1) {
            deltas.push(delta);
          }
        }
      }
      if (!deltas.length) {
        return 30;
      }
      deltas.sort((a, b) => a - b);
      const medianDelta = deltas[Math.floor(deltas.length / 2)];
      return THREE.MathUtils.clamp(Math.round(1 / medianDelta), 1, 240);
    },

    clipCleanupActionKey(entry = this.activeClipEntry) {
      return String(entry?.id || entry?.name || this.actorTarget?.defaultAction || "").trim();
    },

    normalizedClipGroundOffset(value) {
      const offset = Number(value);
      if (!Number.isFinite(offset) || Math.abs(offset) <= CLIP_GROUND_OFFSET_EPSILON) {
        return 0;
      }
      return Number(offset.toFixed(5));
    },

    normalizedClipOrientationQuaternion(value) {
      const values = value?.isQuaternion
        ? [value.x, value.y, value.z, value.w]
        : Array.isArray(value) ? value : [];
      if (values.length !== 4 || values.some((item) => !Number.isFinite(Number(item)))) {
        return null;
      }
      const quaternion = new THREE.Quaternion(
        Number(values[0]),
        Number(values[1]),
        Number(values[2]),
        Number(values[3])
      ).normalize();
      if (
        Math.abs(quaternion.x) <= CLIP_ORIENTATION_EPSILON
        && Math.abs(quaternion.y) <= CLIP_ORIENTATION_EPSILON
        && Math.abs(quaternion.z) <= CLIP_ORIENTATION_EPSILON
        && Math.abs(quaternion.w - 1) <= CLIP_ORIENTATION_EPSILON
      ) {
        return null;
      }
      return [quaternion.x, quaternion.y, quaternion.z, quaternion.w].map((item) => Number(item.toFixed(6)));
    },

    clipCleanupHasData(edit) {
      return false;
    },

    normalizedClipCleanupEdit(edit = {}, fallback = {}) {
      const deletedStartFrames = Math.max(0, Math.floor(Number(edit.deletedStartFrames ?? fallback.deletedStartFrames) || 0));
      const frameRate = Math.max(1, Math.floor(Number(edit.frameRate ?? fallback.frameRate) || 30));
      const groundOffsetY = this.normalizedClipGroundOffset(edit.groundOffsetY ?? fallback.groundOffsetY);
      const orientationQuaternion = this.normalizedClipOrientationQuaternion(edit.orientationQuaternion ?? fallback.orientationQuaternion);
      return { deletedStartFrames, frameRate, groundOffsetY, orientationQuaternion };
    },

    serializeClipCleanupEdits() {
      return [];
    },

    applySerializedClipCleanupEdits(edits = []) {
      this.clipCleanupEdits.clear();
      return false;
    },

    clipCleanupEditForEntry(entry) {
      return null;
    },

    updateClipCleanupEditForEntry(entry, edit) {
      return false;
    },

    clipGroundOffsetForEntry(entry = this.activeClipEntry) {
      return 0;
    },

    clipOrientationQuaternionForEntry(entry = this.activeClipEntry, { identity = false } = {}) {
      return identity ? new THREE.Quaternion() : null;
    },

    applyClipOrientationQuaternion(value) {
      const values = this.normalizedClipOrientationQuaternion(value);
      if (!this.model || !values) {
        return false;
      }
      this.model.quaternion.premultiply(new THREE.Quaternion(values[0], values[1], values[2], values[3]).normalize());
      this.model.updateMatrixWorld(true);
      return true;
    },

    applyClipOrientationForEntry(entry = this.activeClipEntry) {
      return this.applyClipOrientationQuaternion(this.clipOrientationQuaternionForEntry(entry));
    },

    applyClipOrientationBlend(sourceEntry, targetEntry, amount = 0) {
      if (!this.model) {
        return false;
      }
      const source = this.clipOrientationQuaternionForEntry(sourceEntry, { identity: true });
      const target = this.clipOrientationQuaternionForEntry(targetEntry, { identity: true });
      const mixed = source.slerp(target, THREE.MathUtils.clamp(Number(amount) || 0, 0, 1));
      return this.applyClipOrientationQuaternion(mixed);
    },

    applyClipGroundOffsetY(offsetY) {
      const offset = this.normalizedClipGroundOffset(offsetY);
      if (!this.model || !offset) {
        return false;
      }
      this.model.position.y += offset;
      return true;
    },

    applyClipGroundOffsetForEntry(entry = this.activeClipEntry) {
      return this.applyClipGroundOffsetY(this.clipGroundOffsetForEntry(entry));
    },

    applyClipCleanupToEntries() {
      let changed = false;
      for (const entry of this.clipEntries || []) {
        changed = this.applyClipCleanupToEntry(entry) || changed;
      }
      return changed;
    },

    applyClipCleanupToEntry(entry) {
      const edit = this.clipCleanupEditForEntry(entry);
      if (!entry?.sourceClip || !edit?.deletedStartFrames) {
        return false;
      }
      const previousDeletedFrames = Math.max(0, Math.floor(Number(entry.sourceClip.userData?.deletedStartFrames) || 0));
      const remainingFrames = Math.max(0, Math.floor(Number(edit.deletedStartFrames) || 0) - previousDeletedFrames);
      if (remainingFrames <= 0) {
        entry.startOffsetSeconds = 0;
        entry.clip = cloneClipWithStartOffsetApplied(entry.sourceClip, 0);
        return false;
      }
      const frameRate = Math.max(1, Math.floor(Number(edit.frameRate) || this.clipFrameRate(entry.sourceClip)));
      const offsetSeconds = remainingFrames / frameRate;
      const deletedClip = cloneClipWithStartDeleted(entry.sourceClip, offsetSeconds);
      deletedClip.name = entry.sourceClip.name || entry.name || deletedClip.name;
      deletedClip.userData = {
        ...deletedClip.userData,
        deletedStartFrames: previousDeletedFrames + remainingFrames,
        deletedStartFrameRate: frameRate
      };
      entry.sourceClip = deletedClip;
      entry.startOffsetSeconds = 0;
      entry.clip = cloneClipWithStartOffsetApplied(deletedClip, 0);
      return true;
    },

    syncClipCleanupControls() {
      return false;
    },

    skinnedModelMinY({ maxVerticesPerMesh = CLIP_GROUND_MAX_VERTICES_PER_MESH } = {}) {
      if (!this.model || !this.paintRecords?.length) {
        return Number.POSITIVE_INFINITY;
      }
      this.model.updateMatrixWorld(true);
      let minY = Number.POSITIVE_INFINITY;
      for (const record of this.paintRecords) {
        const position = record.geometry?.attributes?.position;
        if (!position?.count) {
          continue;
        }
        const step = Math.max(1, Math.floor(position.count / maxVerticesPerMesh));
        for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += step) {
          if (record.deleted?.has(vertexIndex)) {
            continue;
          }
          this.tempVector.fromBufferAttribute(position, vertexIndex);
          this.applyBoneTransform(record.object, vertexIndex, this.tempVector);
          this.tempWorld.copy(this.tempVector);
          record.object.localToWorld(this.tempWorld);
          minY = Math.min(minY, this.tempWorld.y);
        }
      }
      return minY;
    },

    firstBoneMatching(patterns = []) {
      const list = Array.isArray(patterns) ? patterns : [patterns];
      const bones = [...this.bones.values()];
      for (const pattern of list) {
        const match = bones.find((bone) => pattern.test(this.boneDisplayName?.(bone.name) || bone.name))
          || bones.find((bone) => pattern.test(bone.name));
        if (match) {
          return match;
        }
      }
      return null;
    },

    sampleClipOrientationQuaternion(entry = this.activeClipEntry) {
      if (!entry?.clip || !this.mixer || !this.activeClipAction || !this.model) {
        return null;
      }
      const previousProgress = this.progress;
      const previousClipTime = this.lastClipSampleTime;
      const cleanupKey = this.clipCleanupActionKey(entry);
      const previousCleanupEdit = cleanupKey && this.clipCleanupEdits.has(cleanupKey)
        ? { ...this.clipCleanupEdits.get(cleanupKey) }
        : null;
      if (cleanupKey && previousCleanupEdit) {
        this.clipCleanupEdits.set(cleanupKey, {
          ...previousCleanupEdit,
          groundOffsetY: 0,
          orientationQuaternion: null
        });
      }

      let result = null;
      this.mixer.stopAllAction();
      try {
        this.progress = 0;
        this.resetPose();
        this.applyClipBasePose(0);
        this.model.updateMatrixWorld(true);
        const hips = this.firstBoneMatching([/^Hips$/i, /hips/i]);
        const head = this.firstBoneMatching([/^Head$/i, /head/i, /neck/i, /spine\s*2/i]);
        if (hips && head) {
          const hipsPosition = new THREE.Vector3();
          const headPosition = new THREE.Vector3();
          hips.getWorldPosition(hipsPosition);
          head.getWorldPosition(headPosition);
          const bodyAxis = headPosition.sub(hipsPosition);
          if (bodyAxis.length() > 0.0001) {
            bodyAxis.normalize();
            const sidewaysAmount = Math.max(Math.abs(bodyAxis.x), Math.abs(bodyAxis.z));
            const isSideways = sidewaysAmount > Math.abs(bodyAxis.y) * CLIP_SIDEWAYS_AXIS_RATIO;
            const isUpsideDown = bodyAxis.y < -0.65;
            if (isSideways || isUpsideDown) {
              result = this.normalizedClipOrientationQuaternion(
                new THREE.Quaternion().setFromUnitVectors(bodyAxis, new THREE.Vector3(0, 1, 0))
              );
            }
          }
        }
      } finally {
        if (cleanupKey && previousCleanupEdit) {
          this.clipCleanupEdits.set(cleanupKey, previousCleanupEdit);
        }
        this.progress = previousProgress;
        this.lastClipSampleTime = previousClipTime;
      }

      this.resetPose();
      this.applyPose(previousProgress);
      return result;
    },

    sampleClipGroundOffset(entry = this.activeClipEntry, { samples = CLIP_GROUND_SAMPLE_COUNT } = {}) {
      if (!entry?.clip || !this.mixer || !this.activeClipAction || !this.model) {
        return null;
      }
      const previousProgress = this.progress;
      const previousClipTime = this.lastClipSampleTime;
      const cleanupKey = this.clipCleanupActionKey(entry);
      const previousCleanupEdit = cleanupKey && this.clipCleanupEdits.has(cleanupKey)
        ? { ...this.clipCleanupEdits.get(cleanupKey) }
        : null;
      if (cleanupKey && previousCleanupEdit) {
        this.clipCleanupEdits.set(cleanupKey, {
          ...previousCleanupEdit,
          groundOffsetY: 0
        });
      }
      const sampleCount = Math.max(1, Math.floor(Number(samples) || CLIP_GROUND_SAMPLE_COUNT));
      let minY = Number.POSITIVE_INFINITY;

      this.mixer.stopAllAction();
      try {
        for (let index = 0; index < sampleCount; index += 1) {
          const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1);
          this.progress = progress;
          this.resetPose();
          this.applyClipBasePose(progress);
          this.applyClipOrientationForEntry(entry);
          this.applyPoseLayer();
          minY = Math.min(minY, this.skinnedModelMinY());
        }
      } finally {
        if (cleanupKey && previousCleanupEdit) {
          this.clipCleanupEdits.set(cleanupKey, previousCleanupEdit);
        }
        this.progress = previousProgress;
        this.lastClipSampleTime = previousClipTime;
      }

      this.resetPose();
      this.applyPose(previousProgress);
      if (!Number.isFinite(minY)) {
        return null;
      }
      return this.normalizedClipGroundOffset(-minY);
    },

    async normalizeClipOrientationAndGround(entry = this.activeClipEntry, {
      groundSamples = CLIP_GROUND_SAMPLE_COUNT,
      pushUndo = false,
      silent = false
    } = {}) {
      if (!entry || this.actorTarget?.mode === "bird-flap") {
        if (!silent) {
          this.setStatus("Choose an imported animation clip first");
        }
        return false;
      }
      if (!entry.sourceClip || !entry.clip) {
        await this.loadClipForEntry(entry);
      }
      if (!entry.clip) {
        if (!silent) {
          this.setStatus("No clip to normalize");
        }
        return false;
      }
      if (pushUndo) {
        this.pushUndoState?.("Normalize orientation and ground", { includeClip: true });
      }
      this.discardUnkeyedPosePreview?.({ applyPose: false, syncControls: false, status: false });
      const orientationQuaternion = this.sampleClipOrientationQuaternion(entry);
      const frameRate = this.clipFrameRate(entry.sourceClip || entry.clip);
      this.updateClipCleanupEditForEntry(entry, {
        frameRate,
        ...(orientationQuaternion ? { orientationQuaternion } : {})
      });
      const groundOffsetY = this.sampleClipGroundOffset(entry, { samples: groundSamples });
      if (groundOffsetY == null) {
        if (!silent) {
          this.setStatus("Could not sample animation ground");
        }
        return false;
      }
      this.updateClipCleanupEditForEntry(entry, {
        groundOffsetY,
        frameRate
      });
      await this.playClipEntry(entry);
      this.applyPose(this.progress);
      this.syncTimelineControls();
      this.syncClipCleanupControls();
      this.syncPatchJson();
      const label = entry.name || entry.id || "clip";
      const offsetLabel = groundOffsetY.toFixed(3);
      if (!silent) {
        this.setStatus(`Oriented ${label} and normalized to Y=0 (${offsetLabel}); press Save to keep it`);
      }
      return true;
    },

    async normalizeActiveClipGround() {
      this.setStatus("Ground/orientation cleanup was removed; import raw Mixamo FBX files and edit the pose directly");
      return false;
    },

    async trimActiveClipStartFrames() {
      this.setStatus("Start-frame cleanup was removed; import raw Mixamo FBX files without baked cleanup");
      return false;
    },

    async deleteActiveClipStartFrames() {
      return this.trimActiveClipStartFrames();
    },

    async saveActiveAnimationLibraryCleanup({ silent = false } = {}) {
      const target = this.animationLibraryCleanupSaveTarget();
      if (!target.folder || !target.fileName) {
        return false;
      }
      try {
        const patch = this.syncPatchJson();
        const text = this.serializePatchText?.(patch) || `${JSON.stringify(patch, null, 2)}\n`;
        const saved = await writeAnimationLibraryCleanupFile(target.folder, target.fileName, text);
        if (!saved) {
          return false;
        }
        await this.refreshAnimationLibrary?.({ silent: true });
        if (!silent) {
          this.setStatus(`Saved ${target.fileName} to ${target.folder}`);
        }
        return true;
      } catch (error) {
        console.warn("Could not save animation library cleanup", error);
        return false;
      }
    },

    transferCleanupPatchForEntry(entry = this.blendClipEntry) {
      const patch = this.syncPatchJson();
      const transferPatch = JSON.parse(JSON.stringify(patch));
      delete transferPatch.poseKeyframes;
      delete transferPatch.poseCurveHandles;
      delete transferPatch.poseKeyframeMode;
      delete transferPatch.poseKeyframeAction;
      delete transferPatch.poseKeyframeSource;
      transferPatch.transfer = {
        fromAction: this.activeClipEntry?.id || this.activeClipEntry?.name || "",
        toAction: entry?.id || entry?.name || "",
        copiedAt: new Date().toISOString()
      };
      return transferPatch;
    },

    animationLibraryCleanupSaveTargetForEntry(entry) {
      if (!entry) {
        return { folder: "", fileName: "" };
      }
      if (entry.libraryFolder && entry.libraryCleanupFile) {
        return {
          folder: entry.libraryFolder,
          fileName: entry.libraryCleanupFile
        };
      }
      const folder = entry.libraryFolder
        || this.selectedAnimationLibraryFolderName?.()
        || this.actorTarget?.libraryFolder
        || this.actorTarget?.animationLibraryFolder
        || "";
      const folderRecord = this.animationLibraryFolders.find((item) => item.name === folder);
      const entryId = entry.id || entry.name || "";
      const matchedFile = folderRecord?.files?.find((file) => (
        (file.actionId && file.actionId === entryId)
        || (entry.libraryPath && file.path === entry.libraryPath)
        || (entry.url && file.url === entry.url)
        || (entry.libraryKey && (file.key === entry.libraryKey || file.path === entry.libraryKey))
      ));
      return {
        folder,
        fileName: matchedFile?.cleanupFile
          || entry.libraryCleanupFile
          || this.animationLibraryCleanupFileNameFromLabel(entry.name || entry.id || matchedFile?.name || "blend-target")
      };
    },

    async transferCleanupToBlendAction() {
      if (!this.blendActionId || !this.blendClipEntry) {
        this.setStatus("Choose a Blend To animation first");
        return false;
      }
      const target = this.animationLibraryCleanupSaveTargetForEntry(this.blendClipEntry);
      if (!target.folder || !target.fileName) {
        this.setStatus("Blend To animation is not in a writable project folder");
        return false;
      }
      try {
        const patch = this.transferCleanupPatchForEntry(this.blendClipEntry);
        const text = this.serializePatchText?.(patch) || `${JSON.stringify(patch, null, 2)}\n`;
        const saved = await writeAnimationLibraryCleanupFile(target.folder, target.fileName, text);
        if (!saved) {
          this.setStatus("Could not transfer cleanup to Blend To animation");
          return false;
        }
        this.blendClipEntry.libraryFolder = target.folder;
        this.blendClipEntry.libraryCleanupFile = target.fileName;
        await this.refreshAnimationLibrary?.({ silent: true });
        this.renderActionOptions();
        this.setStatus(`Transferred cleanup to ${this.blendClipEntry.name || this.blendClipEntry.id}`);
        return true;
      } catch (error) {
        console.warn("Could not transfer cleanup to blend target", error);
        this.setStatus("Could not transfer cleanup to Blend To animation");
        return false;
      }
    },

    async savePatchFile({ saveAs = false, saveAsName = "" } = {}) {
      const patch = this.syncPatchJson();
      try {
        const text = this.serializePatchText?.(patch) || `${JSON.stringify(patch, null, 2)}\n`;
        const target = this.animationLibraryCleanupSaveTarget({ saveAsName });
        if (saveAs) {
          if (!target.folder || !target.fileName) {
            this.setStatus(target.folder ? "Name the new cleanup file first" : "Choose an animation library folder first");
            return false;
          }
          const saved = await writeAnimationLibraryCleanupFile(target.folder, target.fileName, text);
          if (!saved) {
            this.setStatus("Could not save to animation library");
            return false;
          }
          await this.refreshAnimationLibrary?.({ silent: true });
          this.setStatus(`Saved ${target.fileName} to ${target.folder}`);
          return true;
        }
        let result = "download";
        if (target.folder && target.fileName) {
          result = await writeAnimationLibraryCleanupFile(
            target.folder,
            target.fileName,
            text
          ) ? "project" : result;
          if (result === "project") {
            await this.refreshAnimationLibrary?.({ silent: true });
            this.setStatus(`Saved ${target.fileName} to ${target.folder}`);
            return true;
          }
        }
        if (result !== "project") {
          result = await writeJsonFile(
            this.patchFileName(),
            text,
            `Mixamo Cleanup ${this.actorTarget.label} weight patch`
          );
        }
        this.setStatus(`${result === "download" ? "Downloaded" : "Saved"} ${this.patchFileName()}`);
        return true;
      } catch (error) {
        this.setStatus(error?.name === "AbortError" ? "Save cancelled" : "Could not save patch JSON");
        return false;
      }
    },

    animationLibraryCleanupSaveTarget({ saveAsName = "" } = {}) {
      const folder = this.selectedAnimationLibraryFolderName?.()
        || this.actorTarget?.libraryFolder
        || this.actorTarget?.animationLibraryFolder
        || "";
      if (saveAsName) {
        return {
          folder,
          fileName: this.animationLibraryCleanupFileNameFromLabel(saveAsName)
        };
      }
      if (this.actorTarget?.libraryFolder && this.actorTarget?.libraryCleanupFile) {
        return {
          folder: this.actorTarget.libraryFolder,
          fileName: this.actorTarget.libraryCleanupFile
        };
      }
      if (this.activeClipEntry?.libraryFolder && this.activeClipEntry?.libraryCleanupFile) {
        return {
          folder: this.activeClipEntry.libraryFolder,
          fileName: this.activeClipEntry.libraryCleanupFile
        };
      }
      const activeActionId = this.activeClipEntry?.id || this.activeClipEntry?.name || this.actorTarget?.defaultAction || "";
      const folderRecord = this.animationLibraryFolders.find((item) => item.name === folder);
      const matchedFile = folderRecord?.files?.find((file) => (
        (file.actorId && file.actorId === this.actorTarget?.id && file.actionId === activeActionId)
        || (file.path && file.path === this.actorTarget?.modelUrl)
        || (file.url && file.url === this.actorTarget?.modelUrl)
        || (this.activeClipEntry?.libraryPath && file.path === this.activeClipEntry.libraryPath)
        || (this.activeClipEntry?.url && file.url === this.activeClipEntry.url)
      ));
      return {
        folder,
        fileName: matchedFile?.cleanupFile || this.patchFileName()
      };
    },

    animationLibraryCleanupFileNameFromLabel(value) {
      const base = String(value || "")
        .trim()
        .replace(/\.json$/i, "")
        .replace(/\.(fbx|glb|gltf|procedural)$/i, "")
        .replace(/\s+/g, "-")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "")
        .slice(0, 120)
        .toLowerCase();
      if (!base) {
        return "";
      }
      return `${base.endsWith("-weight-patch") ? base : `${base}-weight-patch`}.json`;
    },

    async loadPatchFile(file) {
      try {
        const patch = JSON.parse(await file.text());
        this.weightJson.value = JSON.stringify(patch, null, 2);
        this.applyPatchJson();
        this.setStatus(`Loaded ${file.name}`);
      } catch (error) {
        console.error(error);
        this.setStatus("Could not load patch file");
      }
    },

    async loadPatchAsset({ silent = false } = {}) {
      const url = this.patchAssetUrl();
      if (!url) {
        this.syncPatchJson();
        return false;
      }
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        this.weightJson.value = JSON.stringify(await response.json(), null, 2);
        this.applyPatchJson({ status: false });
        if (!silent) {
          this.setStatus(`Loaded ${this.patchFileName()}`);
        }
      } catch (error) {
        this.syncPatchJson();
        if (!silent) {
          this.setStatus(`No saved ${this.patchFileName()} yet`);
        }
        if (!String(error?.message || "").startsWith("HTTP 404")) {
          console.warn(`Could not load ${url}`, error);
        }
      }
    },

    async loadAnimationLibraryCleanupForEntry(entry = this.activeClipEntry, { silent = false } = {}) {
      const target = await this.animationLibraryCleanupTargetForEntry(entry);
      if (!target?.url) {
        return false;
      }
      try {
        const response = await fetch(target.url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        this.weightJson.value = JSON.stringify(await response.json(), null, 2);
        this.applyPatchJson({ status: false });
        if (!silent) {
          this.setStatus(`Loaded ${target.fileName}`);
        }
        return true;
      } catch (error) {
        if (!String(error?.message || "").startsWith("HTTP 404")) {
          console.warn(`Could not load ${target.url}`, error);
        }
        return false;
      }
    },

    async animationLibraryCleanupTargetForEntry(entry = this.activeClipEntry) {
      if (!entry) {
        return null;
      }
      if (entry.libraryFolder && entry.libraryCleanupFile) {
        return {
          folder: entry.libraryFolder,
          fileName: entry.libraryCleanupFile,
          url: entry.libraryCleanupUrl || `./assets/models/animation-library/${entry.libraryFolder}/${entry.libraryCleanupFile}`
        };
      }
      if (!this.animationLibraryFolders.length) {
        await this.refreshAnimationLibrary?.({ silent: true });
      }
      const folderName = this.actorTarget?.animationLibraryFolder
        || this.actorTarget?.libraryFolder
        || this.selectedAnimationLibraryFolderName?.()
        || "";
      const actionId = entry.id || entry.name || this.actorTarget?.defaultAction || "";
      const folder = this.animationLibraryFolders.find((item) => item.name === folderName);
      const matchedFile = folder?.files?.find((file) => (
        (file.actorId && file.actorId === this.actorTarget?.id && file.actionId === actionId)
        || (file.path && file.path === this.actorTarget?.modelUrl)
        || (file.url && file.url === this.actorTarget?.modelUrl)
        || (entry.libraryPath && file.path === entry.libraryPath)
        || (entry.url && file.url === entry.url)
      ));
      if (!folderName || !matchedFile?.cleanupFile) {
        return null;
      }
      return {
        folder: folderName,
        fileName: matchedFile.cleanupFile,
        url: matchedFile.cleanupUrl || `./assets/models/animation-library/${folderName}/${matchedFile.cleanupFile}`
      };
    },

    patchFileName() {
      return this.actorTarget?.patchFile || BIRD_WEIGHT_PATCH_FILE_NAME;
    },

    patchAssetUrl() {
      if (this.actorTarget?.patchUrl) {
        return this.actorTarget.patchUrl;
      }
      return "";
    },

    prepareModel(model, displayHeight = 1.8) {
      model.traverse((object) => {
        object.frustumCulled = false;
        if (object.isSkinnedMesh) {
          object.geometry = object.geometry.clone();
          object.material = this.createEditorMaterialSet(object.material);
        }
      });
    },

    frameLoadedModelInView() {
      if (!this.model || !this.camera || !this.controls) {
        return;
      }
      this.model.visible = true;
      this.model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(this.model);
      if (
        bounds.isEmpty()
        || !Number.isFinite(bounds.min.x)
        || !Number.isFinite(bounds.min.y)
        || !Number.isFinite(bounds.min.z)
        || !Number.isFinite(bounds.max.x)
        || !Number.isFinite(bounds.max.y)
        || !Number.isFinite(bounds.max.z)
      ) {
        return;
      }
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      this.positionGroundReference(bounds, center);
      const height = Math.max(size.y, this.actorTarget?.displayHeight || 1.8, 0.001);
      const distance = Math.max(5.8, height * 3.2);
      const target = center.clone();
      target.y = bounds.min.y + height * 0.45;
      this.controls.target.copy(target);
      this.camera.position.set(center.x, bounds.min.y + height * 0.82, center.z + distance);
      this.camera.lookAt(target);
      this.camera.near = Math.max(0.01, distance / 100);
      this.camera.far = Math.max(220, distance * 100);
      this.camera.updateProjectionMatrix();
      this.controls.maxDistance = Math.max(120, distance * 4);
      this.updateSceneDepthForModelView(distance);
      this.controls.update();
    },

    updateSceneDepthForModelView(distance) {
      const viewDistance = Math.max(1, Number(distance) || 1);
      if (this.scene?.fog) {
        this.scene.fog.near = Math.max(30, viewDistance * 0.25);
        this.scene.fog.far = Math.max(140, viewDistance * 4);
      }
    },

    positionGroundReference(bounds, center = null) {
      if (!bounds || bounds.isEmpty()) {
        return false;
      }
      const groundCenter = center || bounds.getCenter(new THREE.Vector3());
      const groundY = bounds.min.y;
      const size = bounds.getSize(new THREE.Vector3());
      const groundSize = Math.max(8, size.x, size.z, size.y * 0.8) * 3.6;
      const groundScale = groundSize / 8;
      this.groundGrid?.position.set(groundCenter.x, groundY, groundCenter.z);
      this.groundFloor?.position.set(groundCenter.x, groundY - 0.012, groundCenter.z);
      this.groundGrid?.scale.setScalar(groundScale);
      this.groundFloor?.scale.setScalar(groundScale);
      return true;
    },

    syncScaleControls() {
      if (this.scaleControl) {
        this.scaleControl.min = String(PREVIEW_SCALE_CONTROL_MIN);
        this.scaleControl.max = String(PREVIEW_SCALE_CONTROL_MAX);
        this.scaleControl.step = String(PREVIEW_SCALE_CONTROL_STEP);
        this.scaleControl.value = String(this.previewScaleMultiplierToControlValue(this.actorScaleMultiplier));
        this.scaleControl.dataset.scaleMode = "log";
        this.scaleControl.dataset.previewScaleMin = String(PREVIEW_SCALE_MULTIPLIER_MIN);
        this.scaleControl.dataset.previewScaleMax = String(PREVIEW_SCALE_MULTIPLIER_MAX);
      }
      if (this.scaleOutput) {
        this.scaleOutput.textContent = `${formatPreviewScaleMultiplier(this.actorScaleMultiplier)}x`;
      }
    },

    previewScaleControlValueToMultiplier(value) {
      const exponent = THREE.MathUtils.clamp(
        Number(value) || 0,
        PREVIEW_SCALE_CONTROL_MIN,
        PREVIEW_SCALE_CONTROL_MAX
      );
      return Math.pow(10, exponent);
    },

    previewScaleMultiplierToControlValue(value) {
      const clamped = THREE.MathUtils.clamp(
        Number(value) || 1,
        PREVIEW_SCALE_MULTIPLIER_MIN,
        PREVIEW_SCALE_MULTIPLIER_MAX
      );
      return THREE.MathUtils.clamp(Math.log10(clamped), PREVIEW_SCALE_CONTROL_MIN, PREVIEW_SCALE_CONTROL_MAX);
    },

    setActorScaleFromControlValue(value) {
      this.setActorScaleMultiplier(this.previewScaleControlValueToMultiplier(value));
    },

    setActorScaleMultiplier(value) {
      const next = THREE.MathUtils.clamp(Number(value) || 1, PREVIEW_SCALE_MULTIPLIER_MIN, PREVIEW_SCALE_MULTIPLIER_MAX);
      this.actorScaleMultiplier = next;
      if (this.model) {
        const scale = this.baseModelScale * next;
        this.model.scale.setScalar(scale);
        const rootBindPose = this.bindPose.find((entry) => entry.object === this.model);
        if (rootBindPose) {
          rootBindPose.scale.setScalar(scale);
        }
      }
      this.invalidateRootMotionPreviewProfile?.();
      this.syncScaleControls();
      this.updateSelectionMarkers();
      this.updateAllVertexMarkers();
      this.updateMoveGizmo();
      this.updateSkeletonHelper();
      this.updateSelectedBoneHighlight();
      this.updateBonePickerOverlay();
      this.updateBoneLabels();
    },

    createEditorMaterialSet(material) {
      if (Array.isArray(material)) {
        return material.map((entry) => this.createEditorMaterial(entry));
      }
      return this.createEditorMaterial(material);
    },

    createEditorMaterial(sourceMaterial) {
      const material = new THREE.MeshLambertMaterial({
        color: sourceMaterial?.map ? 0xffffff : sourceMaterial?.color?.clone?.() || 0xffffff,
        map: sourceMaterial?.map || null,
        alphaMap: sourceMaterial?.alphaMap || null,
        transparent: Boolean(sourceMaterial?.transparent),
        opacity: Number.isFinite(sourceMaterial?.opacity) ? sourceMaterial.opacity : 1
      });

      material.side = THREE.DoubleSide;
      material.fog = false;
      material.toneMapped = false;
      material.vertexColors = false;
      material.wireframe = false;
      material.depthWrite = true;
      this.prepareMaterialTextures(material);
      material.userData.editorBaseColor = material.color.clone();
      material.userData.editorBaseOpacity = material.opacity;
      material.userData.editorWasTransparent = material.transparent;
      this.applyTextureGainToMaterial?.(material);
      material.needsUpdate = true;
      return material;
    },

    prepareMaterialTextures(material) {
      if (material.map) {
        material.map.colorSpace = THREE.SRGBColorSpace;
        material.map.needsUpdate = true;
      }
      if (material.emissiveMap) {
        material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        material.emissiveMap.needsUpdate = true;
      }
    },

    captureBindPose() {
      const pose = [];
      this.model.traverse((object) => {
        pose.push({
          object,
          position: object.position.clone(),
          quaternion: object.quaternion.clone(),
          scale: object.scale.clone()
        });
      });
      return pose;
    },

    collectBones() {
      this.bones.clear();
      this.model.traverse((object) => {
        if (object.isBone) {
          this.bones.set(object.name, object);
        }
      });
    },

    buildVertexNeighborMap(geometry) {
      const vertexCount = geometry.attributes.position.count;
      const neighbors = Array.from({ length: vertexCount }, () => new Set());
      const addEdge = (a, b) => {
        if (a === b || a < 0 || b < 0 || a >= vertexCount || b >= vertexCount) {
          return;
        }
        neighbors[a].add(b);
        neighbors[b].add(a);
      };
      const index = geometry.index?.array;
      if (index?.length) {
        for (let offset = 0; offset < index.length; offset += 3) {
          const a = index[offset];
          const b = index[offset + 1];
          const c = index[offset + 2];
          addEdge(a, b);
          addEdge(b, c);
          addEdge(c, a);
        }
      } else {
        for (let offset = 0; offset < vertexCount; offset += 3) {
          addEdge(offset, offset + 1);
          addEdge(offset + 1, offset + 2);
          addEdge(offset + 2, offset);
        }
      }
      return neighbors;
    },

    collectPaintableMeshes() {
      this.paintRecords = [];
      this.model.traverse((object) => {
        if (!object.isSkinnedMesh || !object.geometry?.attributes?.position) {
          return;
        }

        const geometry = object.geometry;
        const vertexCount = geometry.attributes.position.count;
        const colors = new Float32Array(vertexCount * 3);
        const colorAttribute = new THREE.BufferAttribute(colors, 3);
        geometry.setAttribute("color", colorAttribute);

        const skinIndex = geometry.attributes.skinIndex;
        const skinWeight = geometry.attributes.skinWeight;
        const xValues = Array.from({ length: vertexCount }, (_, vertexIndex) => geometry.attributes.position.getX(vertexIndex));
        const normal = geometry.attributes.normal;
        const skinSignatureForVertex = (vertexIndex) => {
          const influences = [];
          const itemSize = Math.min(
            skinIndex?.itemSize || 0,
            skinWeight?.itemSize || 0,
            4
          );
          for (let slot = 0; slot < itemSize; slot += 1) {
            const index = Math.round(skinIndex.getComponent(vertexIndex, slot));
            const weight = skinWeight.getComponent(vertexIndex, slot);
            if (weight > 0.0001) {
              influences.push(`${index}:${Math.round(weight * 10000)}`);
            }
          }
          return influences.sort().join(",");
        };
        const normalSignatureForVertex = (vertexIndex) => {
          if (!normal) {
            return "";
          }
          return [
            normal.getX(vertexIndex),
            normal.getY(vertexIndex),
            normal.getZ(vertexIndex)
          ].map((value) => Math.round(value * 1000)).join(":");
        };
        const seamGroups = new Map();
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
          const key = [
            geometry.attributes.position.getX(vertexIndex),
            geometry.attributes.position.getY(vertexIndex),
            geometry.attributes.position.getZ(vertexIndex)
          ].map((value) => Math.round(value * 10000)).join(":")
            + `|${skinSignatureForVertex(vertexIndex)}|${normalSignatureForVertex(vertexIndex)}`;
          if (!seamGroups.has(key)) {
            seamGroups.set(key, []);
          }
          seamGroups.get(key).push(vertexIndex);
        }
        const seamVertexMap = new Map();
        for (const group of seamGroups.values()) {
          if (group.length < 2) {
            continue;
          }
          for (const vertexIndex of group) {
            seamVertexMap.set(vertexIndex, group);
          }
        }
        const record = {
          object,
          geometry,
          selected: new Set(),
          modified: new Set(),
          sculpted: new Set(),
          weightCompensated: new Set(),
          deleted: new Set(),
          colorAttribute,
          originalPosition: geometry.attributes.position.array.slice(),
          originalNormal: geometry.attributes.normal?.array.slice() || null,
          originalIndex: geometry.index?.array ? geometry.index.array.slice() : null,
          originalGroups: geometry.groups?.map((group) => ({ ...group })) || [],
          originalSkinIndex: skinIndex.array.slice(),
          originalSkinWeight: skinWeight.array.slice(),
          mirrorCenterX: (Math.min(...xValues) + Math.max(...xValues)) / 2,
          mirrorVertexCache: new Map(),
          seamVertexMap,
          vertexNeighbors: this.buildVertexNeighborMap(geometry),
          wireOverlay: this.createMeshWireOverlay?.(object, geometry) || null
        };
        this.paintRecords.push(record);
        this.updateRecordColors(record);
      });
    },

    populateBoneSelect() {
      const preferred = [...WING_BONES, ...BODY_BONES];
      const allBoneNames = [...this.bones.keys()];
      const names = [];
      for (const preferredName of preferred) {
        const match = allBoneNames.find((name) => !names.includes(name) && (
          name === preferredName || this.normalizedBoneLabel(name) === this.normalizedBoneLabel(preferredName)
        ));
        if (match) {
          names.push(match);
        }
      }
      const otherNames = allBoneNames.filter((name) => !names.includes(name)).sort();
      const allNames = [...names, ...otherNames];
      const defaultBone = this.findDefaultBone(allNames);
      const currentWeightBone = this.canonicalMirrorBone(this.boneSelect.value || defaultBone);
      const currentPoseBone = this.canonicalMirrorBone(this.poseBoneSelect.value || defaultBone);
      const displayNames = this.mirrorMode ? this.collapsedMirrorBoneNames(allNames) : allNames;
      this.boneLayerNames = displayNames;
      this.boneSelect.replaceChildren(
        ...displayNames.map((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = this.boneDisplayName(name);
          return option;
        })
      );
      this.boneSelect.value = displayNames.includes(currentWeightBone)
        ? currentWeightBone
        : displayNames.includes(defaultBone) ? defaultBone : this.boneSelect.options[0]?.value || "";
      this.poseBoneSelect.replaceChildren(
        ...displayNames.map((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = this.boneDisplayName(name);
          return option;
        })
      );
      this.poseBoneSelect.value = displayNames.includes(currentPoseBone)
        ? currentPoseBone
        : displayNames.includes(defaultBone) ? defaultBone : this.poseBoneSelect.options[0]?.value || "";
      this.activeBoneName = this.poseBoneSelect.value;
      this.syncPoseControls();
      this.updateRigBoneList();
      this.updateBoneLayerList();
      this.updateSelectedBoneHighlight();
      this.renderAddBoneParentOptions();
      this.syncBoneEditorControls(this.activeBoneName);
      this.renderAddBoneChainMemberOptions?.();
      this.renderBoneChainOptions?.();
      this.selectSingleBoneChainMember?.(this.activeBoneName);
      this.syncPoseClipboardControls?.();
      this.updateSelectionInfluences?.();
    }
  });
}
