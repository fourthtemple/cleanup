const TUTORIAL_MACRO_STORAGE_KEY = "fourth-temple-model-cleanup:tutorial-macros:v1";
const DEFAULT_MACRO_NAME = "airbrush";
const MACRO_POINTER_ID = 92817;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function rounded(value, digits = 5) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function roundedArray(values = [], digits = 5) {
  return Array.from(values || []).map((value) => rounded(value, digits));
}

function lerp(left, right, alpha) {
  return left + (right - left) * alpha;
}

function lerpArray(left = [], right = [], alpha) {
  return right.map((value, index) => lerp(Number(left[index] || 0), Number(value || 0), alpha));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function clampPlaybackSpeed(value) {
  return Math.max(0.1, Math.min(4, Number(value) || 1));
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function escapeSelectorValue(value) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(String(value))
    : String(value).replace(/["\\]/g, "\\$&");
}

function macroElementSelector(element) {
  if (!element) {
    return "";
  }
  if (element.id) {
    return `#${escapeSelectorValue(element.id)}`;
  }
  for (const attribute of ["data-tool", "data-view-mode", "data-viewport-layer"]) {
    const value = element.getAttribute?.(attribute);
    if (value) {
      return `[${attribute}="${escapeSelectorValue(value)}"]`;
    }
  }
  return "";
}

function demoNameLabel(name) {
  if (name === "fk-ik") {
    return "FK/IK";
  }
  return String(name || DEFAULT_MACRO_NAME)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function installTutorialMacroMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    loadTutorialMacros() {
      let raw = "";
      try {
        raw = window.localStorage?.getItem(TUTORIAL_MACRO_STORAGE_KEY) || "";
      } catch {
        raw = "";
      }
      const parsed = raw ? safeJsonParse(raw, {}) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    },

    storeTutorialMacros(macros) {
      try {
        window.localStorage?.setItem(TUTORIAL_MACRO_STORAGE_KEY, JSON.stringify(macros || {}));
        return true;
      } catch (error) {
        console.warn("Could not store tutorial macro", error);
        return false;
      }
    },

    tutorialMacro(name = DEFAULT_MACRO_NAME) {
      const macro = this.loadTutorialMacros()[name];
      return macro?.events?.length ? macro : null;
    },

    hasTutorialMacro(name = DEFAULT_MACRO_NAME) {
      return Boolean(this.tutorialMacro(name));
    },

    updateTutorialMacroControls() {
      const enabled = Boolean(this.tutorialEditorEnabled);
      const recording = Boolean(this.tutorialMacroRecording);
      const playing = Boolean(this.tutorialMacroPlaying);
      const activeMacroName = this.tutorialActiveMacroName || this.tutorialMacroPlayingName || "";
      const demoVisible = enabled && Boolean(activeMacroName);
      const hasMacro = activeMacroName ? this.hasTutorialMacro(activeMacroName) : false;
      if (this.tutorialMacroRecordButton) {
        this.tutorialMacroRecordButton.hidden = !enabled || recording;
        this.tutorialMacroRecordButton.disabled = playing || !activeMacroName;
      }
      if (this.tutorialMacroStopButton) {
        this.tutorialMacroStopButton.hidden = !enabled || !recording;
        this.tutorialMacroStopButton.disabled = playing;
      }
      if (this.tutorialDemoControls) {
        this.tutorialDemoControls.hidden = !demoVisible;
      }
      if (this.tutorialMacroPlayButton) {
        this.tutorialMacroPlayButton.textContent = playing ? "Stop Demo" : "Play Demo";
        this.tutorialMacroPlayButton.disabled = recording || !demoVisible || (!playing && !hasMacro);
      }
      if (this.tutorialMacroSpeedSelect) {
        this.tutorialMacroSpeedSelect.disabled = recording || !demoVisible;
      }
      if (this.tutorialMacroScrubInput) {
        this.tutorialMacroScrubInput.disabled = recording || !demoVisible || !hasMacro;
        if (!hasMacro) {
          this.tutorialMacroScrubInput.value = "0";
        }
      }
    },

    bindTutorialMacroControls() {
      if (this.tutorialMacroControlsBound) {
        return;
      }
      this.tutorialMacroControlsBound = true;
      if (this.tutorialMacroSpeedSelect && !this.tutorialMacroSpeedInitialized) {
        this.tutorialMacroSpeedSelect.value = "4";
        this.tutorialMacroSpeedInitialized = true;
      }
      this.tutorialMacroRecordButton?.addEventListener("click", () => {
        void this.startTutorialMacroRecording(this.tutorialActiveMacroName || DEFAULT_MACRO_NAME);
      });
      this.tutorialMacroStopButton?.addEventListener("click", () => {
        void this.stopTutorialMacroRecording();
      });
      this.tutorialMacroPlayButton?.addEventListener("click", () => {
        if (this.tutorialMacroPlaying) {
          this.stopTutorialMacroPlayback();
          return;
        }
        void this.playTutorialMacro(this.tutorialActiveMacroName || DEFAULT_MACRO_NAME);
      });
      for (const eventName of ["click", "pointerdown", "input", "change"]) {
        this.tutorialDemoControls?.addEventListener(eventName, (event) => {
          event.stopPropagation();
        });
      }
      this.tutorialMacroScrubInput?.addEventListener("input", () => {
        if (this.tutorialMacroPlaying) {
          this.tutorialMacroPlaybackSeekRatio = clamp01(Number(this.tutorialMacroScrubInput.value) / 1000);
        }
      });
    },

    attachTutorialDemoControls(source) {
      if (!this.tutorialDemoControls || !source?.dataset?.tutorialMacro) {
        return false;
      }
      if (!source.contains(this.tutorialDemoControls)) {
        source.append(this.tutorialDemoControls);
      }
      return true;
    },

    tutorialMacroPlaybackSpeed() {
      return clampPlaybackSpeed(this.tutorialMacroSpeedSelect?.value);
    },

    tutorialMacroDuration(macro) {
      const events = Array.isArray(macro?.events) ? macro.events : [];
      return Math.max(0, Number(macro?.duration || events.at(-1)?.t || 0) || 0);
    },

    tutorialMacroScrubRatio() {
      return clamp01(Number(this.tutorialMacroScrubInput?.value || 0) / 1000);
    },

    setTutorialMacroScrubRatio(ratio) {
      if (!this.tutorialMacroScrubInput) {
        return;
      }
      this.tutorialMacroScrubInput.value = String(Math.round(clamp01(ratio) * 1000));
    },

    tutorialMacroEventIndexAt(events, time) {
      const targetTime = Math.max(0, Number(time) || 0);
      const index = events.findIndex((event) => Number(event.t || 0) >= targetTime);
      return index >= 0 ? index : events.length;
    },

    tutorialMacroPlaybackSeek(events, duration) {
      if (!Number.isFinite(this.tutorialMacroPlaybackSeekRatio)) {
        return null;
      }
      const ratio = clamp01(this.tutorialMacroPlaybackSeekRatio);
      this.tutorialMacroPlaybackSeekRatio = null;
      const time = ratio * Math.max(0, duration || 0);
      return {
        index: this.tutorialMacroEventIndexAt(events, time),
        time
      };
    },

    async delayTutorialMacroPlayback(ms, token) {
      const endTime = nowMs() + Math.max(0, Number(ms) || 0);
      while (nowMs() < endTime) {
        if (!this.tutorialMacroPlaying || this.tutorialMacroPlaybackToken !== token) {
          return false;
        }
        if (Number.isFinite(this.tutorialMacroPlaybackSeekRatio)) {
          return false;
        }
        await delay(Math.min(45, endTime - nowMs()));
      }
      return true;
    },

    stopTutorialMacroPlayback() {
      if (!this.tutorialMacroPlaying) {
        return false;
      }
      this.tutorialMacroPlaying = false;
      this.tutorialMacroPlayingName = "";
      this.tutorialMacroPlaybackSeekRatio = null;
      this.tutorialMacroPlaybackToken = null;
      this.onPointerUp?.();
      this.hideTutorialMacroPointer();
      this.updateTutorialMacroControls?.();
      this.setStatus("Stopped demo");
      return true;
    },

    bindTutorialMacroSceneEvents() {
      if (this.tutorialMacroSceneEventsBound || !this.canvas) {
        return;
      }
      this.tutorialMacroSceneEventsBound = true;
      this.canvas.addEventListener("pointerdown", (event) => {
        this.tutorialMacroCanvasPointerActive = true;
        this.recordTutorialMacroPointer("down", event);
      }, { capture: true });
      this.canvas.addEventListener("pointermove", (event) => {
        this.recordTutorialMacroPointer("move", event);
      }, { capture: true });
      this.canvas.addEventListener("wheel", (event) => {
        this.recordTutorialMacroPointer("wheel", event);
        this.recordTutorialMacroCameraSample("wheel", { force: true });
      }, { capture: true });
      window.addEventListener("pointerup", (event) => {
        if (!this.tutorialMacroCanvasPointerActive) {
          return;
        }
        this.recordTutorialMacroPointer("up", event);
        this.tutorialMacroCanvasPointerActive = false;
      }, { capture: true });
      this.controls?.addEventListener?.("change", () => {
        this.recordTutorialMacroCameraSample("camera");
      });
      document.addEventListener("click", (event) => {
        this.recordTutorialMacroUiEvent("click", event);
      }, { capture: true });
      document.addEventListener("change", (event) => {
        this.recordTutorialMacroUiEvent("change", event);
      }, { capture: true });
      document.addEventListener("input", (event) => {
        this.recordTutorialMacroUiEvent("input", event);
      }, { capture: true });
    },

    tutorialMacroCameraSnapshot() {
      if (!this.camera || !this.controls) {
        return null;
      }
      return {
        position: roundedArray(this.camera.position.toArray()),
        target: roundedArray(this.controls.target.toArray()),
        up: roundedArray(this.camera.up.toArray()),
        zoom: rounded(this.camera.zoom, 5),
        fov: rounded(this.camera.fov, 5)
      };
    },

    async startTutorialMacroRecording(name = DEFAULT_MACRO_NAME) {
      if (this.tutorialMacroPlaying) {
        this.setStatus("Wait for tutorial macro playback to finish");
        return false;
      }
      this.resetTutorialDemoSceneForImportStep?.("cat");
      const ready = await this.ensureTutorialDemoModelLoaded?.("cat");
      if (!ready) {
        this.setStatus("Load the cat demo before recording the tutorial macro");
        return false;
      }
      if (name === "fk-ik") {
        this.ensureTutorialDemoFkIkChain?.({ status: false });
      }
      const restoreState = this.captureUndoState?.("Tutorial macro baseline", { includeClip: true }) || null;
      const startTime = nowMs();
      this.tutorialMacroRecording = {
        name,
        startTime,
        restoreState,
        events: [],
        lastCameraTime: 0,
        lastPointerTime: 0
      };
      this.recordTutorialMacroToolChange(this.activeTool || "orbit", { force: true });
      this.recordTutorialMacroCameraSample("start", { force: true });
      this.setStatus(`Recording ${demoNameLabel(name)} tutorial macro`);
      this.updateTutorialMacroControls?.();
      return true;
    },

    async stopTutorialMacroRecording({ discard = false } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording) {
        return false;
      }
      this.recordTutorialMacroCameraSample("end", { force: true });
      this.tutorialMacroRecording = null;
      if (discard) {
        this.setStatus("Tutorial macro recording discarded");
        await this.restoreTutorialMacroRecordingBaseline(recording, { status: false });
        this.updateTutorialMacroControls?.();
        return true;
      }
      const events = (recording.events || [])
        .filter((event) => event && Number.isFinite(event.t))
        .sort((left, right) => left.t - right.t);
      const macro = {
        version: 1,
        name: recording.name || DEFAULT_MACRO_NAME,
        createdAt: new Date().toISOString(),
        duration: events.at(-1)?.t || 0,
        events
      };
      const macros = this.loadTutorialMacros();
      macros[macro.name] = macro;
      this.storeTutorialMacros(macros);
      const restored = await this.restoreTutorialMacroRecordingBaseline(recording, { status: false });
      this.setStatus(`Saved ${demoNameLabel(macro.name)} tutorial macro (${events.length} events)${restored ? "; scene reset to the macro start" : ""}`);
      this.updateTutorialMacroControls?.();
      return true;
    },

    async restoreTutorialMacroRecordingBaseline(recording, { status = false } = {}) {
      const restoreState = recording?.restoreState;
      if (!restoreState) {
        return false;
      }
      this.onPointerUp?.();
      this.resetEditableTexturePaints?.({ sync: false });
      const restored = this.restoreEditorState?.(restoreState, "Restored") || false;
      if (status && restored) {
        this.setStatus("Restored tutorial macro baseline");
      }
      await delay(0);
      this.syncPatchJson?.();
      return restored;
    },

    recordTutorialMacroEvent(type, payload = {}, time = nowMs()) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      if ((recording.events || []).length > 2600) {
        return false;
      }
      const t = Math.max(0, time - recording.startTime);
      recording.events.push({
        t: rounded(t, 1),
        type,
        ...payload
      });
      return true;
    },

    recordTutorialMacroCameraSample(reason = "camera", { force = false } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      const time = nowMs();
      if (!force && time - recording.lastCameraTime < 85) {
        return false;
      }
      const camera = this.tutorialMacroCameraSnapshot();
      if (!camera) {
        return false;
      }
      recording.lastCameraTime = time;
      return this.recordTutorialMacroEvent("camera", { reason, camera }, time);
    },

    recordTutorialMacroPointer(kind, event) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying || !event || !this.canvas) {
        return false;
      }
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return false;
      }
      const time = nowMs();
      if (kind === "move" && time - recording.lastPointerTime < 32) {
        return false;
      }
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < -0.08 || y < -0.08 || x > 1.08 || y > 1.08) {
        return false;
      }
      recording.lastPointerTime = time;
      return this.recordTutorialMacroEvent("pointer", {
        kind,
        x: rounded(x, 5),
        y: rounded(y, 5),
        tool: this.activeTool || "",
        button: Number(event.button || 0),
        buttons: Number(event.buttons || 0)
      }, time);
    },

    recordTutorialMacroToolChange(tool, { force = false } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying || (!force && recording.lastTool === tool)) {
        return false;
      }
      recording.lastTool = tool;
      return this.recordTutorialMacroEvent("tool", {
        tool,
        selector: `[data-tool="${tool}"]`
      });
    },

    tutorialMacroUiTarget(event) {
      if (!this.tutorialMacroRecording || this.tutorialMacroPlaying || !event?.target) {
        return null;
      }
      const target = event.target.closest?.("button, select, input, [data-tool], [data-view-mode], [data-viewport-layer]");
      if (!target || target.disabled || target.closest?.("#tutorial-drawer")) {
        return null;
      }
      if (target === this.canvas || target.closest?.("canvas")) {
        return null;
      }
      const selector = macroElementSelector(target);
      if (!selector) {
        return null;
      }
      return target;
    },

    recordTutorialMacroUiEvent(kind, event) {
      const target = this.tutorialMacroUiTarget(event);
      if (!target) {
        return false;
      }
      const tag = target.tagName?.toLowerCase?.() || "";
      const type = target.getAttribute?.("type") || "";
      const isFormControl = tag === "select" || tag === "input";
      if (kind === "click" && isFormControl) {
        return false;
      }
      if ((kind === "change" || kind === "input") && !isFormControl) {
        return false;
      }
      if (kind === "input" && type !== "range") {
        return false;
      }
      const time = nowMs();
      if (kind === "input" && time - (this.tutorialMacroRecording.lastUiInputTime || 0) < 80) {
        return false;
      }
      if (kind === "input") {
        this.tutorialMacroRecording.lastUiInputTime = time;
      }
      return this.recordTutorialMacroEvent("ui", {
        action: kind,
        selector: macroElementSelector(target),
        value: target.value ?? "",
        checked: Boolean(target.checked),
        tag,
        inputType: type
      }, time);
    },

    ensureTutorialMacroPointer() {
      if (this.tutorialMacroPointer) {
        return this.tutorialMacroPointer;
      }
      const pointer = document.createElement("div");
      pointer.className = "tutorial-macro-pointer";
      pointer.hidden = true;
      pointer.setAttribute("aria-hidden", "true");
      document.body.append(pointer);
      this.tutorialMacroPointer = pointer;
      return pointer;
    },

    showTutorialMacroPointer() {
      const pointer = this.ensureTutorialMacroPointer();
      pointer.hidden = false;
      return pointer;
    },

    hideTutorialMacroPointer() {
      if (!this.tutorialMacroPointer) {
        return;
      }
      this.tutorialMacroPointer.hidden = true;
      this.tutorialMacroPointer.classList.remove("is-down", "is-click");
    },

    tutorialMacroCanvasPoint(event) {
      const rect = this.canvas?.getBoundingClientRect?.();
      if (!rect) {
        return null;
      }
      return {
        x: rect.left + Number(event.x || 0) * rect.width,
        y: rect.top + Number(event.y || 0) * rect.height
      };
    },

    moveTutorialMacroPointerTo(point, { down = false, click = false } = {}) {
      if (!point) {
        return;
      }
      const pointer = this.showTutorialMacroPointer();
      pointer.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px)`;
      pointer.classList.toggle("is-down", Boolean(down));
      if (click) {
        pointer.classList.remove("is-click");
        void pointer.offsetWidth;
        pointer.classList.add("is-click");
      }
    },

    tutorialMacroSyntheticPointerEvent(event) {
      const point = this.tutorialMacroCanvasPoint(event);
      return {
        type: event.kind === "move" ? "pointermove" : event.kind === "up" ? "pointerup" : "pointerdown",
        button: event.button || 0,
        buttons: event.kind === "up" ? 0 : event.buttons || 1,
        clientX: point?.x || 0,
        clientY: point?.y || 0,
        pointerId: MACRO_POINTER_ID,
        isPrimary: true,
        target: this.canvas,
        preventDefault() {},
        stopPropagation() {}
      };
    },

    applyTutorialMacroCameraSnapshot(snapshot) {
      if (!snapshot || !this.camera || !this.controls) {
        return;
      }
      this.camera.position.fromArray(snapshot.position || [0, 1.35, 4.2]);
      this.camera.up.fromArray(snapshot.up || [0, 1, 0]).normalize();
      this.controls.target.fromArray(snapshot.target || [0, 0.92, 0]);
      if (Number.isFinite(Number(snapshot.zoom))) {
        this.camera.zoom = Number(snapshot.zoom);
      }
      if (Number.isFinite(Number(snapshot.fov))) {
        this.camera.fov = Number(snapshot.fov);
      }
      this.camera.lookAt(this.controls.target);
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.updateCameraRelativeLights?.();
    },

    async animateTutorialMacroCameraTo(snapshot, duration = 90) {
      if (!snapshot || !this.camera || !this.controls || duration <= 0) {
        this.applyTutorialMacroCameraSnapshot(snapshot);
        return;
      }
      const start = this.tutorialMacroCameraSnapshot();
      const startTime = nowMs();
      await new Promise((resolve) => {
        const tick = () => {
          const alpha = Math.min(1, (nowMs() - startTime) / duration);
          const smooth = alpha * alpha * (3 - 2 * alpha);
          this.applyTutorialMacroCameraSnapshot({
            position: lerpArray(start.position, snapshot.position || start.position, smooth),
            target: lerpArray(start.target, snapshot.target || start.target, smooth),
            up: lerpArray(start.up, snapshot.up || start.up, smooth),
            zoom: lerp(start.zoom, Number(snapshot.zoom || start.zoom), smooth),
            fov: lerp(start.fov, Number(snapshot.fov || start.fov), smooth)
          });
          if (alpha >= 1 || !this.tutorialMacroPlaying) {
            resolve();
            return;
          }
          window.requestAnimationFrame(tick);
        };
        tick();
      });
    },

    async applyTutorialMacroEvent(event, nextEvent) {
      if (!event || !this.tutorialMacroPlaying) {
        return;
      }
      if (event.type === "tool") {
        const target = event.selector ? document.querySelector(event.selector) : null;
        const rect = target?.getBoundingClientRect?.();
        if (rect) {
          this.moveTutorialMacroPointerTo({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          }, { click: true });
          await delay(140 / this.tutorialMacroPlaybackSpeed());
        }
        this.setTool?.(event.tool || "orbit");
        return;
      }
      if (event.type === "ui") {
        const target = event.selector ? document.querySelector(event.selector) : null;
        const rect = target?.getBoundingClientRect?.();
        if (rect) {
          this.moveTutorialMacroPointerTo({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          }, { click: true });
          await delay(120 / this.tutorialMacroPlaybackSpeed());
        }
        if (!target || target.disabled) {
          return;
        }
        if (event.tag === "select" || event.tag === "input") {
          if (event.inputType === "checkbox" || event.inputType === "radio") {
            target.checked = Boolean(event.checked);
          }
          if (event.value !== undefined) {
            target.value = String(event.value);
          }
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        target.click?.();
        return;
      }
      if (event.type === "camera") {
        const duration = Math.min(140, Math.max(40, (nextEvent?.t || event.t + 90) - event.t));
        await this.animateTutorialMacroCameraTo(event.camera, duration / this.tutorialMacroPlaybackSpeed());
        return;
      }
      if (event.type !== "pointer") {
        return;
      }
      const point = this.tutorialMacroCanvasPoint(event);
      this.moveTutorialMacroPointerTo(point, { down: event.kind !== "up" && event.kind !== "wheel" });
      if (event.kind === "wheel" || event.tool === "orbit") {
        return;
      }
      if (event.tool && this.activeTool !== event.tool) {
        this.setTool?.(event.tool);
      }
      const synthetic = this.tutorialMacroSyntheticPointerEvent(event);
      if (event.kind === "down") {
        const originalCapture = this.canvas?.setPointerCapture;
        try {
          if (this.canvas) {
            this.canvas.setPointerCapture = () => {};
          }
          this.onPointerDown?.(synthetic);
        } finally {
          if (this.canvas && originalCapture) {
            this.canvas.setPointerCapture = originalCapture;
          }
        }
      } else if (event.kind === "move") {
        this.onPointerMove?.(synthetic);
      } else if (event.kind === "up") {
        this.onPointerUp?.();
        this.moveTutorialMacroPointerTo(point, { down: false });
      }
    },

    async playTutorialMacro(name = DEFAULT_MACRO_NAME, options = {}) {
      const macroName = name || DEFAULT_MACRO_NAME;
      const label = demoNameLabel(macroName);
      if (this.tutorialMacroRecording) {
        this.setStatus("Stop recording before playing the tutorial macro");
        return false;
      }
      if (this.tutorialMacroPlaying) {
        return false;
      }
      const macro = this.tutorialMacro(macroName);
      if (!macro) {
        if (options.statusIfMissing !== false) {
          this.setStatus(`Record a ${label} tutorial macro first`);
        }
        return false;
      }
      if (options.resetDemo !== false) {
        this.resetTutorialDemoSceneForImportStep?.("cat");
      }
      const ready = await this.ensureTutorialDemoModelLoaded?.("cat");
      if (!ready) {
        this.setStatus("Load the cat demo before playing the tutorial macro");
        return false;
      }
      if (macroName === "fk-ik") {
        this.ensureTutorialDemoFkIkChain?.({ status: false });
      }
      this.tutorialMacroPlaying = true;
      this.tutorialMacroPlayingName = macroName;
      this.updateTutorialMacroControls?.();
      const token = Symbol("tutorial-macro");
      this.tutorialMacroPlaybackToken = token;
      this.tutorialMacroPlaybackSeekRatio = null;
      this.showTutorialMacroPointer();
      this.setStatus(`Playing ${label} demo`);
      try {
        const events = [...macro.events].sort((left, right) => left.t - right.t);
        const duration = this.tutorialMacroDuration(macro);
        let startRatio = this.tutorialMacroScrubRatio();
        if (startRatio >= 0.999) {
          startRatio = 0;
        }
        let previousTime = duration * startRatio;
        let index = this.tutorialMacroEventIndexAt(events, previousTime);
        this.setTutorialMacroScrubRatio(startRatio);
        while (index < events.length) {
          if (!this.tutorialMacroPlaying || this.tutorialMacroPlaybackToken !== token) {
            break;
          }
          const seek = this.tutorialMacroPlaybackSeek(events, duration);
          if (seek) {
            index = seek.index;
            previousTime = seek.time;
            this.setTutorialMacroScrubRatio(duration ? previousTime / duration : 0);
            continue;
          }
          const event = events[index];
          const eventTime = Number(event.t || 0);
          const wait = Math.min(650, Math.max(0, eventTime - previousTime)) / this.tutorialMacroPlaybackSpeed();
          if (wait) {
            const completedWait = await this.delayTutorialMacroPlayback(wait, token);
            if (!completedWait) {
              continue;
            }
          }
          await this.applyTutorialMacroEvent(event, events[index + 1]);
          previousTime = eventTime || previousTime;
          this.setTutorialMacroScrubRatio(duration ? previousTime / duration : 1);
          index += 1;
        }
        this.onPointerUp?.();
        const completed = this.tutorialMacroPlaying && this.tutorialMacroPlaybackToken === token && index >= events.length;
        if (completed) {
          this.setTutorialMacroScrubRatio(1);
          this.setStatus(`Played ${label} demo`);
        }
        return completed;
      } finally {
        if (this.tutorialMacroPlaybackToken === token) {
          this.tutorialMacroPlaybackToken = null;
        }
        this.tutorialMacroPlaying = false;
        this.tutorialMacroPlayingName = "";
        this.tutorialMacroPlaybackSeekRatio = null;
        this.hideTutorialMacroPointer();
        this.updateTutorialMacroControls?.();
      }
    }
  });
}
