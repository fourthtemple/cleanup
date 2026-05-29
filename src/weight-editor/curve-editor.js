export function installCurveEditorMethods(BirdWeightEditor, deps) {
  const {
    THREE,
    OrbitControls,
    TransformControls,
    cloneClipWithStartOffsetApplied,
    configuredClipStartOffsetSeconds,
    remainingClipStartOffsetSeconds,
    loadBirdFlapProfile,
    ACTOR_TARGETS,
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
    writeJsonFile
  } = deps;
  Object.assign(BirdWeightEditor.prototype, {
    clonePose(pose) {
      const clone = {};
      for (const key of CURVE_CHANNEL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(pose || {}, key)) {
          clone[key] = finitePoseValue(pose[key]);
        }
      }
      return clone;
    },

    createCurveToolbar(boneName) {
      const toolbar = document.createElement("div");
      toolbar.className = "bone-layer-curve-toolbar";

      const channelField = document.createElement("label");
      channelField.className = "curve-channel-field";
      const channelLabel = document.createElement("span");
      channelLabel.textContent = "Curve";
      const channelSelect = document.createElement("select");
      channelSelect.replaceChildren(
        ...Object.entries(CURVE_CHANNELS).map(([key, config]) => {
          const option = document.createElement("option");
          option.value = key;
          option.textContent = config.label;
          return option;
        })
      );
      channelSelect.value = this.curveChannel();
      channelSelect.addEventListener("change", () => {
        this.curveValueWindowLock = null;
        this.curveChannelKey = channelSelect.value;
        this.drawCurveEditor();
      });
      channelField.append(channelLabel, channelSelect);

      const loopButton = document.createElement("button");
      loopButton.type = "button";
      loopButton.textContent = "Loop Ends";
      loopButton.title = "Copy the first curve point to the final frame";
      loopButton.addEventListener("click", () => this.withUndo("Loop curve ends", () => this.loopSelectedCurveEnds()));

      const smoothButton = document.createElement("button");
      smoothButton.type = "button";
      smoothButton.textContent = "Smooth";
      smoothButton.title = "Soften the selected curve without adding points";
      smoothButton.addEventListener("click", () => this.withUndo("Smooth curve", () => this.smoothSelectedCurve()));

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete Point";
      deleteButton.title = "Delete the selected curve point nearest the playhead";
      deleteButton.addEventListener("click", () => this.withUndo("Delete curve point", () => this.deleteCurvePointNearFrame(this.currentFrame())));

      const readout = document.createElement("output");
      readout.className = "bone-layer-curve-readout";
      readout.textContent = "Ready";

      toolbar.append(channelField, loopButton, smoothButton, deleteButton, readout);
      this.curveReadout = readout;
      return toolbar;
    },

    createCurvePanel(boneName) {
      const panel = document.createElement("div");
      panel.className = "bone-layer-curve-panel";

      const canvas = document.createElement("canvas");
      canvas.className = "bone-layer-curve-canvas";
      canvas.setAttribute("aria-label", `${this.boneDisplayName(boneName)} animation curve`);
      canvas.dataset.curveBone = boneName;
      const stage = document.createElement("div");
      stage.className = "bone-layer-curve-stage";
      const playhead = document.createElement("div");
      playhead.className = "bone-layer-curve-playhead";
      playhead.setAttribute("aria-hidden", "true");
      this.curveCanvas = canvas;
      this.curveContext = canvas.getContext("2d");
      this.curvePlayhead = playhead;
      this.bindCurveCanvas(canvas);

      stage.append(canvas, playhead);
      panel.append(stage);
      return panel;
    },

    bindCurveCanvas(canvas) {
      canvas.addEventListener("pointerdown", (event) => this.handleCurvePointerDown(event));
      canvas.addEventListener("pointermove", (event) => {
        if (this.curveDragging) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (this.curveDragging) {
          this.handleCurvePointerMove(event);
        } else {
          this.updateCurveReadout(event);
        }
      });
      canvas.addEventListener("pointerup", (event) => this.handleCurvePointerUp(event));
      canvas.addEventListener("pointercancel", (event) => this.handleCurvePointerUp(event));
      canvas.addEventListener("pointerleave", (event) => this.updateCurveReadout(event));
      canvas.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.withUndo("Delete curve point", () => this.deleteCurvePointFromPointer(event));
      });
    },

    curveScrollContainers() {
      return [
        this.boneLayerList || null,
        this.boneLayerList?.closest?.(".weight-timeline-panel") || null,
        document.scrollingElement || document.documentElement || null
      ].filter((element, index, elements) => element && elements.indexOf(element) === index);
    },

    captureCurveScrollState() {
      const state = this.curveScrollContainers().map((element) => ({
        element,
        left: element.scrollLeft,
        top: element.scrollTop
      }));
      state.push({
        window: true,
        left: window.scrollX || 0,
        top: window.scrollY || 0
      });
      return state;
    },

    restoreCurveScrollState(snapshot = this.curveScrollLock) {
      if (!Array.isArray(snapshot)) {
        return;
      }
      for (const item of snapshot) {
        if (item?.window) {
          window.scrollTo(item.left, item.top);
          continue;
        }
        if (!item?.element) {
          continue;
        }
        item.element.scrollLeft = item.left;
        item.element.scrollTop = item.top;
      }
    },

    curveChannel() {
      return CURVE_CHANNELS[this.curveChannelKey] ? this.curveChannelKey : "y";
    },

    curveConfig(options = {}) {
      const channel = this.curveChannel();
      const baseConfig = CURVE_CHANNELS[channel] || CURVE_CHANNELS.y;
      const boneName = this.curveBoneName?.() || "";
      const lock = options.ignoreValueWindowLock ? null : this.curveValueWindowLock;
      if (
        lock
        && lock.channel === channel
        && lock.boneName === boneName
        && Number.isFinite(lock.min)
        && Number.isFinite(lock.max)
        && lock.min < lock.max
      ) {
        return {
          ...baseConfig,
          min: lock.min,
          max: lock.max
        };
      }
      const domain = this.poseControlDomainFor?.(channel, boneName) || baseConfig;
      return {
        ...baseConfig,
        min: domain.min ?? baseConfig.min,
        max: domain.max ?? baseConfig.max
      };
    },

    captureCurveValueWindowLock() {
      const config = this.curveConfig({ ignoreValueWindowLock: true });
      return {
        boneName: this.curveBoneName?.() || "",
        channel: this.curveChannel(),
        min: config.min,
        max: config.max
      };
    },

    curveBoneName() {
      return this.expandedBoneName || this.poseBoneSelect.value;
    },

    curveValueAt(frame, boneName = this.curveBoneName(), channel = this.curveChannel()) {
      const pose = this.interpolatedPoseForFrame(frame)[boneName]
        || this.poseKeyframes.get(Math.round(frame))?.[boneName]
        || {};
      return finitePoseValue(pose[channel]);
    },

    curveKeyFramesFor(boneName = this.curveBoneName(), channel = this.curveChannel()) {
      return [...this.poseKeyframes.entries()]
        .filter(([, framePose]) => framePose?.[boneName]?.[channel] !== undefined)
        .map(([frame, framePose]) => ({ frame, value: finitePoseValue(framePose[boneName][channel]) }))
        .sort((a, b) => a.frame - b.frame);
    },

    drawCurveEditor() {
      if (!this.curveCanvas || !this.curveContext || !this.curveBoneName()) {
        return;
      }
      const rect = this.curveCanvas.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) {
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (this.curveCanvas.width !== width || this.curveCanvas.height !== height) {
        this.curveCanvas.width = width;
        this.curveCanvas.height = height;
      }

      const ctx = this.curveContext;
      ctx.save();
      ctx.scale(dpr, dpr);
      const w = rect.width;
      const h = rect.height;
      const plot = this.curvePlotForRect(rect);
      const channel = this.curveChannel();
      const config = this.curveConfig();
      const boneName = this.curveBoneName();

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(244, 234, 214, 0.08)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = plot.top + (i / 4) * plot.height;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(w - plot.right, y);
        ctx.stroke();
      }
      for (let frame = 0; frame <= this.timelineFrames; frame += 24) {
        const x = this.curveXForFrame(frame, plot);
        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, h - plot.bottom);
        ctx.stroke();
      }

      ctx.strokeStyle = "rgba(223, 180, 93, 0.4)";
      ctx.beginPath();
      const zeroY = this.curveYForValue(0, plot, config);
      ctx.moveTo(plot.left, zeroY);
      ctx.lineTo(w - plot.right, zeroY);
      ctx.stroke();

      ctx.strokeStyle = "rgba(120, 167, 216, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let frame = 0; frame <= this.timelineFrames; frame += 1) {
        const x = this.curveXForFrame(frame, plot);
        const y = this.curveYForValue(this.curveValueAt(frame, boneName, channel), plot, config);
        if (frame === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      ctx.fillStyle = "rgba(244, 234, 214, 0.78)";
      for (const { frame, value } of this.curveKeyFramesFor(boneName, channel)) {
        const x = this.curveXForFrame(frame, plot);
        const y = this.curveYForValue(value, plot, config);
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }

      ctx.fillStyle = "rgba(244, 234, 214, 0.72)";
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      ctx.fillText(config.max.toFixed(config.decimals), 4, plot.top + 4);
      ctx.fillText(config.min.toFixed(config.decimals), 4, h - plot.bottom + 3);
      ctx.restore();

      const currentFrame = this.progress * this.timelineFrames;
      const currentValue = this.curveValueAt(currentFrame, boneName, channel);
      if (this.curveReadout) {
        this.curveReadout.value = `${this.boneDisplayName(boneName)} ${config.label}: ${currentValue.toFixed(config.decimals)}`;
        this.curveReadout.textContent = this.curveReadout.value;
      }
      this.updateCurvePlayhead();
    },

    updateCurvePlayhead() {
      if (!this.curveCanvas || !this.curvePlayhead) {
        return;
      }
      const rect = this.curveCanvas.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) {
        this.curvePlayhead.hidden = true;
        return;
      }
      const plot = this.curvePlotForRect(rect);
      const x = this.curveXForFrame(this.progress * this.timelineFrames, plot);
      this.curvePlayhead.hidden = false;
      this.curvePlayhead.style.left = `${x}px`;
      this.curvePlayhead.style.top = `${plot.top}px`;
      this.curvePlayhead.style.height = `${plot.height}px`;
    },

    curvePlotForRect(rect) {
      const left = 38;
      const right = 12;
      const top = 12;
      const bottom = 22;
      return {
        left,
        right,
        top,
        bottom,
        width: Math.max(1, rect.width - left - right),
        height: Math.max(1, rect.height - top - bottom)
      };
    },

    curveXForFrame(frame, plot) {
      return plot.left + (frame / this.timelineFrames) * plot.width;
    },

    curveYForValue(value, plot, config = this.curveConfig()) {
      const t = (THREE.MathUtils.clamp(value, config.min, config.max) - config.min) / (config.max - config.min);
      return plot.top + (1 - t) * plot.height;
    },

    pointerToCurvePoint(event) {
      const rect = this.curveCanvas.getBoundingClientRect();
      const plot = this.curvePlotForRect(rect);
      const config = this.curveConfig();
      const x = THREE.MathUtils.clamp(event.clientX - rect.left, plot.left, rect.width - plot.right);
      const y = THREE.MathUtils.clamp(event.clientY - rect.top, plot.top, rect.height - plot.bottom);
      const frame = Math.round(((x - plot.left) / plot.width) * this.timelineFrames);
      const valueT = 1 - (y - plot.top) / plot.height;
      const value = THREE.MathUtils.lerp(config.min, config.max, valueT);
      return { frame: Math.max(0, Math.min(this.timelineFrames, frame)), value };
    },

    nearestCurveKeyFromPointer(event, threshold = 12) {
      if (!this.curveCanvas) {
        return null;
      }
      const rect = this.curveCanvas.getBoundingClientRect();
      const plot = this.curvePlotForRect(rect);
      const config = this.curveConfig();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      let nearest = null;
      for (const key of this.curveKeyFramesFor()) {
        const x = this.curveXForFrame(key.frame, plot);
        const y = this.curveYForValue(key.value, plot, config);
        const distance = Math.hypot(pointerX - x, pointerY - y);
        if (!nearest || distance < nearest.distance) {
          nearest = { ...key, distance };
        }
      }
      return nearest && nearest.distance <= threshold ? nearest : null;
    },

    handleCurvePointerDown(event) {
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 2) {
        return;
      }
      if (event.altKey || event.shiftKey) {
        this.withUndo("Delete curve point", () => this.deleteCurvePointFromPointer(event));
        return;
      }
      this.pausePlayback();
      this.curveValueWindowLock = this.captureCurveValueWindowLock();
      const point = this.pointerToCurvePoint(event);
      const nearest = this.nearestCurveKeyFromPointer(event);
      const frame = nearest?.frame ?? point.frame;
      this.beginPoseControlUndo("Curve edit");
      this.curveScrollLock = this.captureCurveScrollState();
      this.curveDragging = { frame, pointerId: event.pointerId };
      try {
        this.curveCanvas.setPointerCapture?.(event.pointerId);
      } catch (error) {
        // Synthetic verifier events and some embedded browsers can reject capture for inactive pointer ids.
      }
      this.setCurveValueAtFrame(frame, point.value, { rebuild: false });
      this.restoreCurveScrollState();
    },

    handleCurvePointerMove(event) {
      if (!this.curveDragging) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const point = this.pointerToCurvePoint(event);
      const sourceFrame = this.curveDragging.frame;
      this.setCurveValueAtFrame(point.frame, point.value, { sourceFrame, rebuild: false });
      this.curveDragging.frame = point.frame;
      this.restoreCurveScrollState();
    },

    handleCurvePointerUp(event) {
      if (!this.curveDragging) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        this.curveCanvas?.releasePointerCapture?.(event.pointerId);
      } catch (error) {
        // See the matching setPointerCapture guard above.
      }
      this.curveDragging = null;
      this.endPoseControlUndo();
      this.updateTimelineKeyMarkers();
      this.restoreCurveScrollState();
      const scrollLock = this.curveScrollLock;
      const valueWindowLock = this.curveValueWindowLock;
      this.curveScrollLock = null;
      requestAnimationFrame(() => {
        this.curveValueWindowLock = valueWindowLock;
        this.restoreCurveScrollState(scrollLock);
        this.drawCurveEditor();
      });
    },

    updateCurveReadout(event) {
      if (!this.curveReadout) {
        return;
      }
      const { frame, value } = this.pointerToCurvePoint(event);
      const config = this.curveConfig();
      this.curveReadout.value = `Frame ${frame}: ${value.toFixed(config.decimals)}`;
      this.curveReadout.textContent = this.curveReadout.value;
    },

    setCurveValueAtFrame(frame, value, { sourceFrame = null, rebuild = true } = {}) {
      const boneName = this.curveBoneName();
      const channel = this.curveChannel();
      if (!boneName || !this.bones.has(boneName)) {
        return;
      }
      this.markPoseKeyframesAuthored?.();
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const framePose = this.poseKeyframes.get(targetFrame) || {};
      const sourceFramePose = sourceFrame !== null ? this.poseKeyframes.get(sourceFrame) : null;
      const sourceBonePose = sourceFramePose?.[boneName];
      const shouldMoveWholeBoneKey = sourceFrame !== null && sourceFrame !== targetFrame && sourceBonePose;
      framePose[boneName] = shouldMoveWholeBoneKey
        ? {
          ...this.clonePose(framePose[boneName] || {}),
          ...this.clonePose(sourceBonePose)
        }
        : this.clonePose(framePose[boneName] || this.poseLayerFallbackForFrame(targetFrame, boneName));
      framePose[boneName][channel] = finitePoseValue(value);
      this.poseKeyframes.set(targetFrame, framePose);
      if (this.actorTarget?.mode !== "bird-flap") {
        this.ensureAdditivePoseAnchors(boneName, targetFrame, [channel]);
      }
      if (shouldMoveWholeBoneKey) {
        delete sourceFramePose[boneName];
        if (!Object.keys(sourceFramePose).length) {
          this.poseKeyframes.delete(sourceFrame);
        }
      } else if (sourceFrame !== null && sourceFrame !== targetFrame) {
        this.deleteCurvePointAtFrame(sourceFrame, { silent: true, rebuild: false });
      }
      this.manualPose.delete(boneName);
      this.progress = targetFrame / this.timelineFrames;
      this.timeScrub.value = String(this.progress);
      this.syncTimelineControls();
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone();
      this.syncPatchJson();
      if (rebuild) {
        this.updateTimelineKeyMarkers();
      } else {
        this.drawCurveEditor();
      }
      this.restoreCurveScrollState();
    },

    poseLayerFallbackForFrame(frame, boneName) {
      if (this.actorTarget?.mode !== "bird-flap") {
        return this.manualPose.get(boneName)
          || this.interpolatedPoseForFrame(frame)?.[boneName]
          || { x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0 };
      }
      return this.getBoneRelativePose(boneName);
    },

    ensureAdditivePoseAnchors(boneName, frame, channels = CURVE_CHANNEL_KEYS) {
      if (this.actorTarget?.mode === "bird-flap" || !boneName) {
        return;
      }
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const previousAnchor = targetFrame - ADDITIVE_POSE_EASE_FRAMES;
      const nextAnchor = Math.min(this.timelineFrames, targetFrame + ADDITIVE_POSE_EASE_FRAMES);
      for (const channel of channels.filter((key) => CURVE_CHANNELS[key])) {
        if (previousAnchor > 0 && !this.hasPoseChannelBefore(boneName, channel, targetFrame)) {
          this.setPoseChannelIfMissing(previousAnchor, boneName, channel, 0);
        }
        if (
          targetFrame >= ADDITIVE_POSE_EASE_FRAMES
          && !this.hasPoseChannelAfter(boneName, channel, targetFrame)
          && nextAnchor !== targetFrame
        ) {
          this.setPoseChannelIfMissing(nextAnchor, boneName, channel, 0);
        }
      }
    },

    setPoseChannelIfMissing(frame, boneName, channel, value) {
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const framePose = this.poseKeyframes.get(targetFrame) || {};
      const bonePose = framePose[boneName] || {};
      if (bonePose[channel] === undefined) {
        bonePose[channel] = finitePoseValue(value);
        framePose[boneName] = bonePose;
        this.poseKeyframes.set(targetFrame, framePose);
      }
    },

    hasPoseChannelBefore(boneName, channel, frame) {
      return [...this.poseKeyframes.entries()].some(([keyedFrame, framePose]) => (
        keyedFrame < frame && framePose?.[boneName]?.[channel] !== undefined
      ));
    },

    hasPoseChannelAfter(boneName, channel, frame) {
      return [...this.poseKeyframes.entries()].some(([keyedFrame, framePose]) => (
        keyedFrame > frame && framePose?.[boneName]?.[channel] !== undefined
      ));
    },

    deleteCurvePointFromPointer(event) {
      const nearest = this.nearestCurveKeyFromPointer(event, 14);
      if (!nearest) {
        this.setStatus("No curve point there");
        return;
      }
      this.deleteCurvePointAtFrame(nearest.frame);
    },

    deleteCurvePointNearFrame(frame) {
      const keys = this.curveKeyFramesFor();
      if (!keys.length) {
        this.setStatus("No curve points");
        return;
      }
      const nearest = keys.reduce((best, key) => {
        const distance = Math.abs(key.frame - frame);
        return !best || distance < best.distance ? { ...key, distance } : best;
      }, null);
      this.deleteCurvePointAtFrame(nearest.frame);
    },

    deleteCurvePointAtFrame(frame, { silent = false, rebuild = true } = {}) {
      const boneName = this.curveBoneName();
      const channel = this.curveChannel();
      const targetFrame = Math.max(0, Math.min(this.timelineFrames, Math.round(frame)));
      const framePose = this.poseKeyframes.get(targetFrame);
      const bonePose = framePose?.[boneName];
      if (!bonePose || bonePose[channel] === undefined) {
        if (!silent) {
          this.setStatus("No curve point there");
        }
        return false;
      }
      this.markPoseKeyframesAuthored?.();
      delete bonePose[channel];
      if (!Object.keys(bonePose).length) {
        delete framePose[boneName];
      }
      if (!Object.keys(framePose).length) {
        this.poseKeyframes.delete(targetFrame);
      }
      this.syncPatchJson();
      this.applyPose(this.progress);
      if (rebuild) {
        this.updateTimelineKeyMarkers();
      } else {
        this.drawCurveEditor();
      }
      if (!silent) {
        this.setStatus(`Deleted ${this.curveConfig().label} point at frame ${targetFrame}`);
      }
      return true;
    },

    loopSelectedCurveEnds() {
      const boneName = this.curveBoneName();
      const channel = this.curveChannel();
      const startPose = this.poseKeyframes.get(0)?.[boneName] || this.interpolatedPoseForFrame(0)[boneName];
      if (!startPose) {
        this.setStatus("No start curve value");
        return;
      }
      this.setCurveValueAtFrame(this.timelineFrames, finitePoseValue(startPose[channel]));
      this.setStatus(`Looped ${this.boneDisplayName(boneName)} ${this.curveConfig().label}`);
    },

    smoothSelectedCurve() {
      const boneName = this.curveBoneName();
      const channel = this.curveChannel();
      const frames = [...this.poseKeyframes.keys()]
        .filter((frame) => this.poseKeyframes.get(frame)?.[boneName]?.[channel] !== undefined)
        .sort((a, b) => a - b);
      if (frames.length < 3) {
        this.setStatus("Need at least 3 curve keys to smooth");
        return;
      }
      const values = new Map(frames.map((frame) => [frame, this.poseKeyframes.get(frame)[boneName][channel]]));
      this.markPoseKeyframesAuthored?.();
      for (let index = 0; index < frames.length; index += 1) {
        const previous = frames[(index - 1 + frames.length) % frames.length];
        const current = frames[index];
        const next = frames[(index + 1) % frames.length];
        const smoothed = values.get(previous) * 0.25 + values.get(current) * 0.5 + values.get(next) * 0.25;
        const framePose = this.poseKeyframes.get(current);
        framePose[boneName] = this.clonePose(framePose[boneName]);
        framePose[boneName][channel] = smoothed;
      }
      if (this.poseKeyframes.get(0)?.[boneName] && this.poseKeyframes.get(this.timelineFrames)?.[boneName]) {
        this.poseKeyframes.get(this.timelineFrames)[boneName][channel] = this.poseKeyframes.get(0)[boneName][channel];
      }
      this.applyPose(this.progress);
      this.syncPoseControlsToCurrentBone();
      this.syncPatchJson();
      this.updateTimelineKeyMarkers();
      this.setStatus(`Smoothed ${this.boneDisplayName(boneName)} ${this.curveConfig().label}`);
    }
  });
}
