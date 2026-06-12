const TUTORIAL_MACRO_STORAGE_KEY = "fourth-temple-model-cleanup:tutorial-macros:v1";
const TUTORIAL_MACRO_DRAFT_STORAGE_KEY = "fourth-temple-model-cleanup:tutorial-macro-draft:v1";
const TUTORIAL_MACRO_DB_NAME = "fourth-temple-model-cleanup-tutorial-macros";
const TUTORIAL_MACRO_DB_VERSION = 1;
const TUTORIAL_MACRO_DB_STORE = "records";
const TUTORIAL_MACRO_ASSET_URL = "./assets/tutorial-macros.json?v=20260609a";
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
  return Math.max(0.1, Math.min(8, Number(value) || 1));
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sanitizedMacroName(value, fallback = DEFAULT_MACRO_NAME) {
  const name = String(value || "").trim();
  return name || fallback;
}

function normalizedTutorialMacro(name, macro) {
  if (!macro || !Array.isArray(macro.events)) {
    return null;
  }
  const events = macro.events
    .filter((event) => event && event.type !== "state" && Number.isFinite(Number(event.t)))
    .map((event) => ({
      ...event,
      t: Number(event.t)
    }))
    .sort((left, right) => left.t - right.t);
  if (!events.length) {
    return null;
  }
  const macroName = sanitizedMacroName(macro.name || name);
  return {
    version: Number.isFinite(Number(macro.version)) ? Number(macro.version) : 1,
    name: macroName,
    createdAt: String(macro.createdAt || new Date().toISOString()),
    duration: Math.max(
      0,
      Number(events.at(-1)?.t || 0) || 0,
      Number(macro.duration || 0) || 0
    ),
    events
  };
}

function normalizedTutorialMacroMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  if (Array.isArray(value.events)) {
    const macro = normalizedTutorialMacro(value.name || DEFAULT_MACRO_NAME, value);
    return macro ? { [macro.name]: macro } : {};
  }
  const macros = {};
  for (const [name, macro] of Object.entries(value)) {
    const normalized = normalizedTutorialMacro(name, macro);
    if (normalized) {
      macros[normalized.name] = normalized;
    }
  }
  return macros;
}

function tutorialMacrosFromImportPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  if (payload.macros && typeof payload.macros === "object") {
    return normalizedTutorialMacroMap(payload.macros);
  }
  if (payload.tutorialMacros && typeof payload.tutorialMacros === "object") {
    return normalizedTutorialMacroMap(payload.tutorialMacros);
  }
  return normalizedTutorialMacroMap(payload);
}

function tutorialMacroExportFileName() {
  const date = new Date().toISOString().slice(0, 10);
  return `fourth-temple-model-cleanup-tutorial-macros-${date}.json`;
}

function tutorialMacroDbKey(kind, name) {
  return `${kind}:${sanitizedMacroName(name)}`;
}

function openTutorialMacroDb() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TUTORIAL_MACRO_DB_NAME, TUTORIAL_MACRO_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TUTORIAL_MACRO_DB_STORE)) {
        db.createObjectStore(TUTORIAL_MACRO_DB_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open tutorial macro storage"));
  });
}

async function tutorialMacroDbRecords(kind = "") {
  const db = await openTutorialMacroDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TUTORIAL_MACRO_DB_STORE, "readonly");
    const request = transaction.objectStore(TUTORIAL_MACRO_DB_STORE).getAll();
    request.onsuccess = () => {
      const records = Array.isArray(request.result) ? request.result : [];
      resolve(kind ? records.filter((record) => record?.kind === kind) : records);
    };
    request.onerror = () => reject(request.error || new Error("Could not read tutorial macros"));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not read tutorial macros"));
    };
  });
}

async function putTutorialMacroDbRecord(record) {
  const db = await openTutorialMacroDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TUTORIAL_MACRO_DB_STORE, "readwrite");
    transaction.objectStore(TUTORIAL_MACRO_DB_STORE).put(record);
    transaction.oncomplete = () => {
      db.close();
      resolve(true);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not store tutorial macro"));
    };
  });
}

async function deleteTutorialMacroDbRecord(kind, name) {
  const db = await openTutorialMacroDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TUTORIAL_MACRO_DB_STORE, "readwrite");
    transaction.objectStore(TUTORIAL_MACRO_DB_STORE).delete(tutorialMacroDbKey(kind, name));
    transaction.oncomplete = () => {
      db.close();
      resolve(true);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Could not delete tutorial macro"));
    };
  });
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
  for (const attribute of [
    "data-tool",
    "data-view-mode",
    "data-viewport-layer",
    "data-rig-bone-group",
    "data-rig-bone-name",
    "data-camera",
    "data-camera-axis",
    "data-joint-constraint-capture"
  ]) {
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
  const { writeJsonFile } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    async loadPackagedTutorialMacros() {
      if (this.tutorialMacroPackagedLoaded) {
        return this.tutorialMacroPackagedCache || {};
      }
      this.tutorialMacroPackagedLoaded = true;
      try {
        const response = await fetch(TUTORIAL_MACRO_ASSET_URL);
        if (!response.ok) {
          this.tutorialMacroPackagedCache = {};
          return {};
        }
        const payload = await response.json();
        this.tutorialMacroPackagedCache = tutorialMacrosFromImportPayload(payload);
        this.updateTutorialMacroControls?.();
        return this.tutorialMacroPackagedCache;
      } catch (error) {
        console.warn("Could not load packaged tutorial macros", error);
        this.tutorialMacroPackagedCache = {};
        return {};
      }
    },

    loadTutorialMacros() {
      let raw = "";
      try {
        raw = window.localStorage?.getItem(TUTORIAL_MACRO_STORAGE_KEY) || "";
      } catch {
        raw = "";
      }
      const parsed = raw ? safeJsonParse(raw, {}) : {};
      const localMacros = normalizedTutorialMacroMap(parsed && typeof parsed === "object" ? parsed : {});
      const browserMacros = this.tutorialMacroCache || {};
      const packagedMacros = this.tutorialMacroPackagedCache || {};
      const localOverrideMacros = {
        ...localMacros,
        ...browserMacros
      };
      const macros = this.tutorialEditorEnabled
        ? { ...packagedMacros, ...localOverrideMacros }
        : { ...localOverrideMacros, ...packagedMacros };
      const draft = this.loadTutorialMacroDraft?.();
      if (draft && !macros[draft.name]) {
        macros[draft.name] = draft;
      }
      return macros;
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

    async loadTutorialMacrosFromIndexedDb() {
      try {
        const records = await tutorialMacroDbRecords("macro");
        const macros = {};
        for (const record of records) {
          const macro = normalizedTutorialMacro(record.name, record.macro);
          if (macro) {
            macros[macro.name] = macro;
          }
        }
        this.tutorialMacroCache = macros;
        const drafts = await tutorialMacroDbRecords("draft");
        const sortedDrafts = drafts
          .map((record) => normalizedTutorialMacro(record.name, record.macro))
          .filter(Boolean)
          .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0));
        this.tutorialMacroDraftCache = sortedDrafts[0] || null;
        this.updateTutorialMacroControls?.();
        return macros;
      } catch (error) {
        console.warn("Could not load tutorial macros from browser database", error);
        return this.tutorialMacroCache || {};
      }
    },

    async storeTutorialMacroInIndexedDb(macro, kind = "macro") {
      const normalized = normalizedTutorialMacro(macro?.name || DEFAULT_MACRO_NAME, macro);
      if (!normalized) {
        return false;
      }
      await putTutorialMacroDbRecord({
        key: tutorialMacroDbKey(kind, normalized.name),
        kind,
        name: normalized.name,
        updatedAt: new Date().toISOString(),
        macro: normalized
      });
      if (kind === "macro") {
        this.tutorialMacroCache ||= {};
        this.tutorialMacroCache[normalized.name] = normalized;
      } else if (kind === "draft") {
        this.tutorialMacroDraftCache = normalized;
      }
      return true;
    },

    loadTutorialMacroDraft() {
      if (this.tutorialMacroDraftCache?.events?.length) {
        return this.tutorialMacroDraftCache;
      }
      let raw = "";
      try {
        raw = window.localStorage?.getItem(TUTORIAL_MACRO_DRAFT_STORAGE_KEY) || "";
      } catch {
        raw = "";
      }
      const draft = normalizedTutorialMacro("draft", raw ? safeJsonParse(raw, null) : null);
      return draft?.events?.length ? draft : null;
    },

    clearTutorialMacroDraft(name = "") {
      const draftName = name || this.tutorialMacroDraftCache?.name || "";
      this.tutorialMacroDraftCache = null;
      if (draftName) {
        void deleteTutorialMacroDbRecord("draft", draftName).catch((error) => {
          console.warn("Could not clear tutorial macro draft from browser database", error);
        });
      }
      try {
        if (!name) {
          window.localStorage?.removeItem(TUTORIAL_MACRO_DRAFT_STORAGE_KEY);
          return true;
        }
        const draft = this.loadTutorialMacroDraft?.();
        if (!draft || draft.name === name) {
          window.localStorage?.removeItem(TUTORIAL_MACRO_DRAFT_STORAGE_KEY);
        }
        return true;
      } catch (error) {
        console.warn("Could not clear tutorial macro draft", error);
        return false;
      }
    },

    storeTutorialMacroDraft(recording, { force = false } = {}) {
      if (!recording?.events?.length) {
        return false;
      }
      const time = nowMs();
      if (!force && time - (recording.lastDraftSaveTime || 0) < 900) {
        return false;
      }
      recording.lastDraftSaveTime = time;
      const events = (recording.events || [])
        .filter((event) => event && event.type !== "state" && Number.isFinite(event.t))
        .sort((left, right) => left.t - right.t);
      const draft = {
        version: 1,
        name: recording.name || DEFAULT_MACRO_NAME,
        createdAt: recording.createdAt || new Date(recording.wallStartTime || Date.now()).toISOString(),
        updatedAt: new Date().toISOString(),
        duration: Math.max(
          Number(events.at(-1)?.t || 0) || 0,
          Number(nowMs() - (recording.startTime || nowMs())) || 0
        ),
        draft: true,
        events
      };
      this.tutorialMacroDraftCache = draft;
      void this.storeTutorialMacroInIndexedDb?.(draft, "draft").catch((error) => {
        console.warn("Could not store tutorial macro draft in browser database", error);
      });
      try {
        const text = JSON.stringify(draft);
        if (text.length > 1_000_000) {
          window.localStorage?.removeItem(TUTORIAL_MACRO_DRAFT_STORAGE_KEY);
          return true;
        }
        window.localStorage?.setItem(TUTORIAL_MACRO_DRAFT_STORAGE_KEY, text);
        return true;
      } catch (error) {
        console.warn("Could not store tutorial macro draft", error);
        return true;
      }
    },

    compactTutorialMacroForStorage(macro) {
      const events = (macro?.events || [])
        .filter((event) => event?.type !== "state")
        .sort((left, right) => left.t - right.t);
      return {
        ...macro,
        compacted: true,
        duration: Math.max(
          0,
          Number(macro?.duration || 0) || 0,
          Number(events.at(-1)?.t || 0) || 0
        ),
        events
      };
    },

    async saveTutorialMacroAsset(macros) {
      const normalized = normalizedTutorialMacroMap(macros);
      const response = await fetch("/api/tutorial-macros", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macros: normalized })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Could not save tutorial macros to disk");
      }
      this.tutorialMacroPackagedCache = normalized;
      this.tutorialMacroPackagedLoaded = true;
      return await response.json();
    },

    async storeTutorialMacroWithFallback(existingMacros, macro) {
      const macroName = macro?.name || DEFAULT_MACRO_NAME;
      const nextMacros = {
        ...(existingMacros || {}),
        [macroName]: macro
      };
      try {
        await this.saveTutorialMacroAsset(nextMacros);
        return { stored: true, disk: true, compacted: false, macro };
      } catch (error) {
        console.warn("Could not save tutorial macro asset", error);
      }

      try {
        if (await this.storeTutorialMacroInIndexedDb?.(macro, "macro")) {
          return { stored: true, indexedDb: true, compacted: false, macro };
        }
      } catch (error) {
        console.warn("Could not store tutorial macro in browser database", error);
      }
      if (this.storeTutorialMacros(nextMacros)) {
        return { stored: true, compacted: false, macro };
      }

      const compactMacro = this.compactTutorialMacroForStorage(macro);
      const compactNextMacros = {
        ...(existingMacros || {}),
        [macroName]: compactMacro
      };
      if (this.storeTutorialMacros(compactNextMacros)) {
        return { stored: true, compacted: true, macro: compactMacro };
      }
      if (this.storeTutorialMacros({ [macroName]: compactMacro })) {
        return { stored: true, compacted: true, replacedOtherMacros: true, macro: compactMacro };
      }
      const withoutTarget = { ...(existingMacros || {}) };
      delete withoutTarget[macroName];
      this.storeTutorialMacros(withoutTarget);
      return { stored: false, compacted: true, macro: compactMacro };
    },

    tutorialMacro(name = DEFAULT_MACRO_NAME) {
      const macro = this.loadTutorialMacros()[name];
      return macro?.events?.length ? macro : null;
    },

    hasTutorialMacro(name = DEFAULT_MACRO_NAME) {
      return Boolean(this.tutorialMacro(name));
    },

    savedTutorialMacroNames() {
      return Object.keys(normalizedTutorialMacroMap(this.loadTutorialMacros()));
    },

    updateTutorialMacroControls() {
      const enabled = Boolean(this.tutorialEditorEnabled && this.tutorialMacroModeActive?.());
      const recording = Boolean(this.tutorialMacroRecording);
      const recordingName = this.tutorialMacroRecording?.name || "";
      const playing = Boolean(this.tutorialMacroPlaying);
      const activeMacroName = this.tutorialActiveMacroName || this.tutorialMacroPlayingName || "";
      const demoVisible = enabled && Boolean(activeMacroName);
      const hasMacro = activeMacroName ? this.hasTutorialMacro(activeMacroName) : false;
      const recordingActiveMacro = recording && activeMacroName === recordingName;
      const hasAnyMacro = this.savedTutorialMacroNames().length > 0;
      if (this.tutorialMacroRecordButton) {
        this.tutorialMacroRecordButton.hidden = !enabled || recording;
        this.tutorialMacroRecordButton.disabled = playing || !activeMacroName;
      }
      if (this.tutorialMacroStopButton) {
        this.tutorialMacroStopButton.hidden = !enabled || !recording;
        this.tutorialMacroStopButton.disabled = playing;
      }
      if (this.tutorialMacroExportButton) {
        this.tutorialMacroExportButton.hidden = !enabled;
        this.tutorialMacroExportButton.disabled = recording || playing || !hasAnyMacro;
      }
      if (this.tutorialMacroImportButton) {
        this.tutorialMacroImportButton.hidden = !enabled;
        this.tutorialMacroImportButton.disabled = recording || playing;
      }
      if (this.tutorialDemoControls) {
        this.tutorialDemoControls.hidden = !demoVisible;
      }
      if (this.tutorialMacroPlayButton) {
        this.tutorialMacroPlayButton.textContent = playing ? "Stop Demo" : recordingActiveMacro ? "Save & Play" : "Play Demo";
        this.tutorialMacroPlayButton.disabled = !demoVisible || (recording ? !recordingActiveMacro : (!playing && !hasMacro));
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
      void (async () => {
        await this.loadPackagedTutorialMacros?.();
        await this.loadTutorialMacrosFromIndexedDb?.();
      })();
      this.tutorialMacroRecordButton?.addEventListener("click", () => {
        void this.startTutorialMacroRecording(this.tutorialActiveMacroName || DEFAULT_MACRO_NAME);
      });
      this.tutorialMacroStopButton?.addEventListener("click", () => {
        void this.stopTutorialMacroRecording();
      });
      this.tutorialMacroExportButton?.addEventListener("click", () => {
        void this.exportTutorialMacros();
      });
      this.tutorialMacroImportButton?.addEventListener("click", () => {
        if (!this.tutorialMacroImportFileInput) {
          this.setStatus("Tutorial macro import is not available");
          return;
        }
        this.tutorialMacroImportFileInput.value = "";
        this.tutorialMacroImportFileInput.click();
      });
      this.tutorialMacroImportFileInput?.addEventListener("change", () => {
        const file = this.tutorialMacroImportFileInput.files?.[0];
        if (file) {
          void this.importTutorialMacrosFromFile(file);
        }
      });
      this.tutorialMacroPlayButton?.addEventListener("click", () => {
        if (this.tutorialMacroRecording) {
          const recordingName = this.tutorialMacroRecording.name || this.tutorialActiveMacroName || DEFAULT_MACRO_NAME;
          void (async () => {
            const saved = await this.stopTutorialMacroRecording();
            if (saved) {
              await this.playTutorialMacro(recordingName);
            }
          })();
          return;
        }
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
      this.updateTutorialMacroControls?.();
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

    tutorialMacroPlaybackEvents(macro) {
      const events = [...(macro?.events || [])].sort((left, right) => left.t - right.t);
      const travelCameraTimes = events
        .filter((event) => (
          event?.type === "camera"
          && (event.reason === "travel-follow" || event.reason === "camera-pan")
        ))
        .map((event) => Number(event.t || 0))
        .filter(Number.isFinite);
      if (!travelCameraTimes.length) {
        return events;
      }
      return events.filter((event) => {
        if (event?.type !== "camera" || event.reason !== "camera") {
          return true;
        }
        const eventTime = Number(event.t || 0);
        return !travelCameraTimes.some((travelTime) => Math.abs(travelTime - eventTime) <= 90);
      });
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

    async exportTutorialMacros() {
      if (this.tutorialMacroRecording || this.tutorialMacroPlaying) {
        this.setStatus("Stop recording or playback before exporting macros");
        return false;
      }
      await this.loadTutorialMacrosFromIndexedDb?.();
      const macros = normalizedTutorialMacroMap(this.loadTutorialMacros());
      const names = Object.keys(macros);
      if (!names.length) {
        this.setStatus("No tutorial macros to export");
        this.updateTutorialMacroControls?.();
        return false;
      }
      const payload = {
        version: 1,
        app: "Fourth Temple Model Cleanup",
        storageKey: TUTORIAL_MACRO_STORAGE_KEY,
        exportedAt: new Date().toISOString(),
        macros
      };
      const text = JSON.stringify(payload, null, 2);
      try {
        const mode = await writeJsonFile(tutorialMacroExportFileName(), text, "Tutorial macro backup");
        const label = names.map((name) => demoNameLabel(name)).join(", ");
        this.setStatus(`${mode === "download" ? "Downloaded" : "Saved"} tutorial macro backup: ${label}`);
        return true;
      } catch (error) {
        console.warn("Could not export tutorial macros", error);
        this.setStatus("Could not export tutorial macros");
        return false;
      }
    },

    async importTutorialMacrosFromFile(file) {
      if (this.tutorialMacroRecording || this.tutorialMacroPlaying) {
        this.setStatus("Stop recording or playback before importing macros");
        return false;
      }
      let payload = null;
      try {
        payload = JSON.parse(await file.text());
      } catch (error) {
        console.warn("Could not read tutorial macro backup", error);
        this.setStatus("Could not read tutorial macro backup");
        return false;
      }
      const incoming = tutorialMacrosFromImportPayload(payload);
      const names = Object.keys(incoming);
      if (!names.length) {
        this.setStatus("No tutorial macros found in that backup");
        this.updateTutorialMacroControls?.();
        return false;
      }
      await this.loadTutorialMacrosFromIndexedDb?.();
      const existing = normalizedTutorialMacroMap(this.loadTutorialMacros());
      const overwritten = names.filter((name) => existing[name]).length;
      let stored = true;
      for (const macro of Object.values(incoming)) {
        const result = await this.storeTutorialMacroWithFallback(this.loadTutorialMacros(), macro);
        stored = stored && result.stored;
      }
      this.updateTutorialMacroControls?.();
      if (!stored) {
        this.setStatus("Could not import tutorial macros; browser storage is full");
        return false;
      }
      const label = names.map((name) => demoNameLabel(name)).join(", ");
      this.setStatus(`Imported tutorial macro backup: ${label}${overwritten ? ` (${overwritten} replaced)` : ""}`);
      return true;
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

    async delayTutorialMacroPlayback(logicalMs, token) {
      let remaining = Math.max(0, Number(logicalMs) || 0);
      let lastTime = nowMs();
      while (remaining > 0) {
        if (!this.tutorialMacroPlaying || this.tutorialMacroPlaybackToken !== token) {
          return false;
        }
        if (Number.isFinite(this.tutorialMacroPlaybackSeekRatio)) {
          return false;
        }
        const time = nowMs();
        const elapsed = Math.max(0, time - lastTime);
        lastTime = time;
        remaining -= elapsed * this.tutorialMacroPlaybackSpeed();
        if (remaining <= 0) {
          break;
        }
        const speed = this.tutorialMacroPlaybackSpeed();
        await delay(Math.min(45, remaining / speed));
      }
      return true;
    },

    shouldSkipTutorialMacroEventForSpeed(event, nextEvent) {
      const speed = this.tutorialMacroPlaybackSpeed();
      if (speed < 1.5 || event?.type !== "pointer" || event.kind !== "move") {
        return false;
      }
      if (nextEvent?.type !== "pointer" || nextEvent.kind !== "move" || nextEvent.tool !== event.tool) {
        return false;
      }
      const eventTime = Number(event.t || 0);
      const nextTime = Number(nextEvent.t || 0);
      const maxMoveStep = speed >= 6 ? 70 : speed >= 4 ? 52 : speed >= 2 ? 34 : 22;
      return nextTime - eventTime <= maxMoveStep;
    },

    async waitForTutorialMacroRestoreIdle({ timeoutMs = 3600 } = {}) {
      const startTime = nowMs();
      while (this.historyRestoreBusy || this.pendingSerializedTexturePaintsApply) {
        const pendingTextureApply = this.pendingSerializedTexturePaintsApply;
        if (pendingTextureApply) {
          await Promise.race([
            pendingTextureApply.catch(() => null),
            delay(80)
          ]);
        } else {
          await delay(35);
        }
        if (nowMs() - startTime > timeoutMs) {
          return false;
        }
      }
      return true;
    },

    clearTutorialMacroRecordingHighlights() {
      for (const element of this.tutorialHighlightedElements || []) {
        element.classList.remove("tutorial-highlight-target");
      }
      for (const target of document.querySelectorAll(".tutorial-macro-click-target")) {
        target.classList.remove("tutorial-macro-click-target");
        if (target.tutorialMacroClickTimer) {
          window.clearTimeout(target.tutorialMacroClickTimer);
          target.tutorialMacroClickTimer = null;
        }
      }
      this.tutorialBackdrop?.classList.remove("is-highlight-mode");
      this.tutorialHighlightedElements = [];
    },

    setTutorialMacroRecordingBackdrop(recording) {
      this.tutorialBackdrop?.classList.toggle("is-macro-recording", Boolean(recording));
    },

    setTutorialMacroPlaybackBackdrop(playing) {
      this.tutorialBackdrop?.classList.toggle("is-macro-playback", Boolean(playing));
      if (playing) {
        this.tutorialBackdrop?.classList.remove("is-highlight-mode");
      }
    },

    stopTutorialMacroScenePlayback() {
      this.stopSequencePreview?.({ applyPose: true, resetElapsed: false });
      this.pausePlayback?.();
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
      this.stopTutorialMacroScenePlayback?.();
      this.hideTutorialMacroPointer();
      this.setTutorialMacroPlaybackBackdrop?.(false);
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
        if (this.tutorialMacroSuppressControlsCameraSample) {
          return;
        }
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

    tutorialMacroScrollTargetIntoView(target) {
      if (!target) {
        return false;
      }
      const section = target.closest?.(".viewer-section");
      if (section) {
        this.setPanelSectionOpen?.(section, true);
      }
      target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "auto" });
      return true;
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
      const ready = await this.ensureTutorialDemoModelLoaded?.("cat");
      if (!ready) {
        this.setStatus("Load the cat demo before recording the tutorial macro");
        return false;
      }
      if (name === "fk-ik") {
        this.ensureTutorialDemoFkIkChain?.({ status: false });
      }
      this.clearTutorialMacroRecordingHighlights?.();
      this.setTutorialMacroRecordingBackdrop?.(true);
      const restoreState = this.captureUndoState?.("Tutorial macro baseline", { includeClip: true }) || null;
      const startTime = nowMs();
      this.tutorialMacroRecording = {
        name,
        startTime,
        wallStartTime: Date.now(),
        createdAt: new Date().toISOString(),
        restoreState,
        events: [],
        lastDraftSaveTime: 0,
        lastCameraTime: 0,
        lastPointerTime: 0,
        lastPoseStateTime: 0,
        lastPoseStateKey: ""
      };
      this.recordTutorialMacroToolChange(this.activeTool || "orbit", { force: true });
      this.recordTutorialMacroBrushState("start");
      this.recordTutorialMacroCameraSample("start", { force: true });
      this.recordTutorialMacroPoseState("start", { force: true });
      this.storeTutorialMacroDraft?.(this.tutorialMacroRecording, { force: true });
      this.setStatus(`Recording ${demoNameLabel(name)} tutorial macro`);
      this.updateTutorialMacroControls?.();
      return true;
    },

    async stopTutorialMacroRecording({ discard = false } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording) {
        return false;
      }
      this.storeTutorialMacroDraft?.(recording, { force: true });
      try {
        this.onPointerUp?.();
        await this.waitForTutorialMacroRestoreIdle?.({ timeoutMs: 4600 });
        this.recordTutorialMacroBrushState("end");
        this.recordTutorialMacroCameraSample("end", { force: true });
        this.recordTutorialMacroChainSelection(this.selectedBoneChainMemberNamesFromControl?.() || [], { force: true });
        this.recordTutorialMacroPoseState("end", { force: true });
        this.storeTutorialMacroDraft?.(recording, { force: true });
      } catch (error) {
        console.warn("Could not finish tutorial macro stop cleanup", error);
        this.storeTutorialMacroDraft?.(recording, { force: true });
      }
      this.tutorialMacroRecording = null;
      this.setTutorialMacroRecordingBackdrop?.(false);
      if (discard) {
        this.clearTutorialMacroDraft?.(recording.name || DEFAULT_MACRO_NAME);
        this.setStatus("Tutorial macro recording discarded");
        await this.restoreTutorialMacroRecordingBaseline(recording, { status: false });
        this.updateTutorialMacroControls?.();
        return true;
      }
      const events = (recording.events || [])
        .filter((event) => event && event.type !== "state" && Number.isFinite(event.t))
        .sort((left, right) => left.t - right.t);
      const macro = {
        version: 1,
        name: recording.name || DEFAULT_MACRO_NAME,
        createdAt: new Date().toISOString(),
        duration: Math.max(
          Number(events.at(-1)?.t || 0) || 0,
          Number(nowMs() - (recording.startTime || nowMs())) || 0
        ),
        events
      };
      const storageResult = await this.storeTutorialMacroWithFallback(this.loadTutorialMacros(), macro);
      const stored = storageResult.stored;
      if (stored) {
        this.clearTutorialMacroDraft?.(macro.name);
      }
      const restored = await this.restoreTutorialMacroRecordingBaseline(recording, { status: false });
      this.setStatus(stored
        ? `Saved ${storageResult.compacted ? "compact " : ""}${demoNameLabel(macro.name)} tutorial macro ${storageResult.disk ? "to disk" : "in browser"} (${storageResult.macro.events.length} events)${restored ? "; scene reset to the macro start" : ""}`
        : `Could not save ${demoNameLabel(macro.name)} tutorial macro; browser storage is full`);
      this.updateTutorialMacroControls?.();
      return stored;
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
      const t = Math.max(0, time - recording.startTime);
      recording.events.push({
        t: rounded(t, 1),
        type,
        ...payload
      });
      this.storeTutorialMacroDraft?.(recording);
      return true;
    },

    recordTutorialMacroCameraSample(reason = "camera", { force = false, minInterval = 85 } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      const time = nowMs();
      if (!force && time - recording.lastCameraTime < Math.max(0, Number(minInterval) || 0)) {
        return false;
      }
      const camera = this.tutorialMacroCameraSnapshot();
      if (!camera) {
        return false;
      }
      recording.lastCameraTime = time;
      return this.recordTutorialMacroEvent("camera", { reason, camera }, time);
    },

    tutorialMacroStateCheckpoint(label = "Tutorial macro checkpoint") {
      const state = this.captureUndoState?.(label, { includeClip: false });
      if (!state) {
        return null;
      }
      delete state.clipState;
      state.includeClip = false;
      Object.assign(state, this.tutorialMacroViewportStateSnapshot());
      return state;
    },

    tutorialMacroViewportStateSnapshot() {
      return {
        viewMode: this.viewMode || "",
        cleanPreview: Boolean(this.cleanPreview),
        gizmoOnlyPreview: Boolean(this.gizmoOnlyPreview),
        viewportLayers: {
          rendered: this.showRenderedLayer !== false,
          mesh: Boolean(this.showMeshLayer),
          selection: this.showSelectionLayer !== false,
          bones: Boolean(this.showBonesLayer)
        }
      };
    },

    tutorialMacroPoseStateSnapshot() {
      return {
        progress: rounded(this.progress || 0, 6),
        frame: this.currentFrame?.() ?? Math.round((this.progress || 0) * (this.timelineFrames || 0)),
        activeTool: this.activeTool || "",
        ...this.tutorialMacroViewportStateSnapshot(),
        activeBoneName: this.activeBoneName || "",
        poseBoneName: this.poseBoneSelect?.value || "",
        selectedBoneChainRootName: this.selectedBoneChainRootName || "",
        selectedChainMembers: this.selectedBoneChainMemberNamesFromControl?.() || [],
        poseGizmoMode: this.activePoseGizmoMode?.() || "",
        poseKeyframeMode: this.poseKeyframeMode,
        poseKeyframesGenerated: Boolean(this.poseKeyframesGenerated),
        timelineKeysSourceWasAutoGenerated: Boolean(this.timelineKeysSourceWasAutoGenerated),
        poseKeyframes: this.serializePoseKeyframes?.() || [],
        adaptiveGuideKeyframes: this.serializePoseKeyframeMap?.(this.adaptiveGuideKeyframes) || [],
        adaptiveGuideDeltaKeyframes: this.serializePoseKeyframeMap?.(this.adaptiveGuideDeltaKeyframes) || [],
        adaptivePoseKeyframes: this.serializePoseKeyframeMap?.(this.adaptivePoseKeyframes) || [],
        poseCurveHandles: this.serializePoseCurveHandles?.() || [],
        manualPoseAdditiveNames: [...(this.manualPoseAdditiveNames || [])],
        manualPoseEditedChannels: [...(this.manualPoseEditedChannels || new Map()).entries()]
          .map(([name, channels]) => [name, [...channels]]),
        manualPose: [...(this.manualPose || new Map()).entries()]
          .map(([name, pose]) => [name, { ...pose }])
      };
    },

    tutorialMacroPoseStateKey(state) {
      return JSON.stringify({
        frame: state?.frame,
        activeTool: state?.activeTool,
        viewMode: state?.viewMode,
        cleanPreview: state?.cleanPreview,
        gizmoOnlyPreview: state?.gizmoOnlyPreview,
        viewportLayers: state?.viewportLayers,
        activeBoneName: state?.activeBoneName,
        poseBoneName: state?.poseBoneName,
        chain: state?.selectedChainMembers,
        mode: state?.poseGizmoMode,
        keyMode: state?.poseKeyframeMode,
        generated: state?.poseKeyframesGenerated,
        sourceWasGenerated: state?.timelineKeysSourceWasAutoGenerated,
        poseKeys: state?.poseKeyframes,
        adaptiveGuideKeys: state?.adaptiveGuideKeyframes,
        adaptiveKeys: state?.adaptivePoseKeyframes,
        manualPose: state?.manualPose,
        manualAdditive: state?.manualPoseAdditiveNames
      });
    },

    recordTutorialMacroPoseState(reason = "pose", { force = false } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      const time = nowMs();
      if (!force && time - (recording.lastPoseStateTime || 0) < 150) {
        return false;
      }
      const state = this.tutorialMacroPoseStateSnapshot();
      const key = this.tutorialMacroPoseStateKey(state);
      if (!force && key === recording.lastPoseStateKey) {
        return false;
      }
      recording.lastPoseStateTime = time;
      recording.lastPoseStateKey = key;
      return this.recordTutorialMacroEvent("pose-state", { reason, state }, time);
    },

    scheduleTutorialMacroPoseState(reason = "pose", options = {}) {
      if (!this.tutorialMacroRecording || this.tutorialMacroPlaying) {
        return false;
      }
      window.setTimeout(() => {
        this.recordTutorialMacroPoseState(reason, options);
      }, Math.max(0, Number(options.delayMs) || 0));
      return true;
    },

    recordTutorialMacroStateCheckpoint(reason = "checkpoint") {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      const state = this.tutorialMacroStateCheckpoint(`Tutorial ${reason}`);
      if (!state) {
        return false;
      }
      return this.recordTutorialMacroEvent("state", { reason, state });
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
      if (kind === "move" && time - recording.lastPointerTime < 16) {
        return false;
      }
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < -0.08 || y < -0.08 || x > 1.08 || y > 1.08) {
        return false;
      }
      recording.lastPointerTime = time;
      const brush = this.activeTool === "airbrush" || this.activeTool === "clone"
        ? this.tutorialMacroBrushSettingsSnapshot?.()
        : null;
      const recorded = this.recordTutorialMacroEvent("pointer", {
        kind,
        x: rounded(x, 5),
        y: rounded(y, 5),
        tool: this.activeTool || "",
        ...(brush ? { brush } : {}),
        button: Number(event.button || 0),
        buttons: Number(event.buttons || 0),
        deltaX: rounded(event.deltaX || 0, 3),
        deltaY: rounded(event.deltaY || 0, 3)
      }, time);
      if (recorded && (this.activeTool === "bone" || this.boneMoveDrag || this.ikDrag)) {
        this.scheduleTutorialMacroPoseState(`pointer-${kind}`, { force: kind === "up" });
      }
      return recorded;
    },

    tutorialMacroBrushSettingsSnapshot() {
      const colorBytes = this.textureAirbrushColor?.() || null;
      return {
        color: String(this.texturePaintColor?.value || "#c06f4f").toLowerCase(),
        ...(colorBytes ? { colorBytes: { r: colorBytes.r, g: colorBytes.g, b: colorBytes.b } } : {}),
        radius: rounded(this.textureBrushRadius?.value || this.brushRadius?.value || 0.035, 5),
        radiusPixels: rounded(this.textureBrushRadiusScreenPixels?.() || 24, 3),
        opacity: rounded(this.textureBrushOpacity?.value || 0.42, 5),
        hardness: rounded(this.textureBrushHardness?.value || 0.35, 5),
        scatter: rounded(this.textureBrushScatter?.value || 0.35, 5)
      };
    },

    applyTutorialMacroBrushSettings(settings = {}) {
      if (!settings || typeof settings !== "object") {
        return false;
      }
      const entries = [
        [this.texturePaintColor, settings.color],
        [this.textureBrushRadius, settings.radius],
        [this.textureBrushOpacity, settings.opacity],
        [this.textureBrushHardness, settings.hardness],
        [this.textureBrushScatter, settings.scatter]
      ];
      let changed = false;
      for (const [target, value] of entries) {
        if (!target || value === undefined || value === null) {
          continue;
        }
        const nextValue = String(value);
        if (target.value !== nextValue) {
          target.value = nextValue;
          changed = true;
        }
      }
      this.updateRangeOutputs?.();
      if (changed) {
        for (const [target, value] of entries) {
          if (!target || value === undefined || value === null) {
            continue;
          }
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      return true;
    },

    recordTutorialMacroBrushState(reason = "brush") {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      return this.recordTutorialMacroEvent("brush", {
        reason,
        settings: this.tutorialMacroBrushSettingsSnapshot()
      });
    },

    recordTutorialMacroPaintBrushState() {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying || (this.activeTool !== "airbrush" && this.activeTool !== "clone")) {
        return null;
      }
      const brush = this.tutorialMacroBrushSettingsSnapshot();
      const currentT = Math.max(0, nowMs() - recording.startTime);
      const events = recording.events || [];
      for (let index = events.length - 1; index >= 0 && index >= events.length - 8; index -= 1) {
        const event = events[index];
        if (event?.type !== "pointer" || event.tool !== this.activeTool) {
          continue;
        }
        if (currentT - Number(event.t || 0) > 260) {
          break;
        }
        event.brush = brush;
        event.brushSource = "paint";
        return brush;
      }
      this.recordTutorialMacroEvent("brush", {
        reason: "paint",
        settings: brush
      });
      return brush;
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

    recordTutorialMacroChainSelection(names = this.selectedBoneChainMemberNamesFromControl?.() || [], { force = false } = {}) {
      const recording = this.tutorialMacroRecording;
      if (!recording || this.tutorialMacroPlaying) {
        return false;
      }
      const selectedValues = [...new Set(names)]
        .filter((name) => this.bones?.has?.(name));
      if (!selectedValues.length) {
        return false;
      }
      const key = selectedValues.join("|");
      if (!force && recording.lastChainSelectionKey === key) {
        return false;
      }
      recording.lastChainSelectionKey = key;
      const recorded = this.recordTutorialMacroEvent("chain-selection", {
        selector: "#add-bone-chain-members",
        selectedValues,
        labels: selectedValues.map((name) => this.boneDisplayName?.(name) || name),
        activeBoneName: this.activeBoneName || ""
      });
      if (recorded) {
        this.showTutorialMacroChainSelection?.(selectedValues, { target: this.addBoneChainMembersSelect, status: false });
        this.scheduleTutorialMacroPoseState("chain-selection", { force: true });
      }
      return recorded;
    },

    tutorialMacroViewportTogglePayload(target) {
      if (target === this.cleanPreviewButton || target?.id === "clean-preview") {
        return {
          viewportToggle: "clean-preview",
          cleanPreview: !this.cleanPreview,
          gizmoOnlyPreview: false
        };
      }
      if (target === this.gizmoOnlyPreviewButton || target?.id === "gizmo-only-preview") {
        const enabled = !this.gizmoOnlyPreview;
        return {
          viewportToggle: "gizmo-only-preview",
          cleanPreview: enabled,
          gizmoOnlyPreview: enabled
        };
      }
      return null;
    },

    tutorialMacroUiTarget(event) {
      if (!this.tutorialMacroRecording || this.tutorialMacroPlaying || !event?.target) {
        return null;
      }
      const target = event.target.closest?.("button, select, input, [data-tool], [data-view-mode], [data-viewport-layer], [data-rig-bone-group], [data-rig-bone-name], [data-camera], [data-camera-axis], [data-joint-constraint-capture]");
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
      const recordsLiveInput = tag === "select" || type === "range" || type === "color";
      if (kind === "input" && !recordsLiveInput) {
        return false;
      }
      const time = nowMs();
      if (kind === "input") {
        const selector = macroElementSelector(target);
        const inputKey = `${selector}:${type || tag}`;
        this.tutorialMacroRecording.lastUiInputTimes ||= new Map();
        const throttleMs = type === "range" ? 80 : 0;
        if (throttleMs && time - (this.tutorialMacroRecording.lastUiInputTimes.get(inputKey) || 0) < throttleMs) {
          return false;
        }
        this.tutorialMacroRecording.lastUiInputTimes.set(inputKey, time);
      }
      const selectedValues = tag === "select" && target.multiple
        ? Array.from(target.selectedOptions || []).map((option) => option.value)
        : null;
      const viewportToggle = this.tutorialMacroViewportTogglePayload(target);
      if ((kind === "change" || kind === "input") && target === this.addBoneChainMembersSelect && selectedValues?.length) {
        this.recordTutorialMacroChainSelection(selectedValues);
      }
      const recorded = this.recordTutorialMacroEvent("ui", {
        action: kind,
        selector: macroElementSelector(target),
        value: target.value ?? "",
        ...(selectedValues ? { selectedValues } : {}),
        ...(viewportToggle || {}),
        checked: Boolean(target.checked),
        tag,
        inputType: type
      }, time);
      if (recorded) {
        this.flashTutorialMacroTarget?.(target);
      }
      if (recorded) {
        this.scheduleTutorialMacroPoseState(`ui-${kind}`, { force: kind !== "input", delayMs: 0 });
      }
      return recorded;
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

    flashTutorialMacroTarget(target) {
      if (!target?.classList) {
        return false;
      }
      target.classList.remove("tutorial-macro-click-target");
      void target.offsetWidth;
      target.classList.add("tutorial-macro-click-target");
      if (target.tutorialMacroClickTimer) {
        window.clearTimeout(target.tutorialMacroClickTimer);
      }
      target.tutorialMacroClickTimer = window.setTimeout(() => {
        target.classList.remove("tutorial-macro-click-target");
        target.tutorialMacroClickTimer = null;
      }, 520);
      return true;
    },

    tutorialMacroChainMemberTargets(names = []) {
      const targets = [];
      const seen = new Set();
      const addTarget = (target) => {
        if (!target || seen.has(target)) {
          return;
        }
        seen.add(target);
        targets.push(target);
      };
      for (const name of names) {
        const selectorName = escapeSelectorValue(name);
        addTarget(document.querySelector(`[data-rig-bone-name="${selectorName}"]`));
        const option = Array.from(this.addBoneChainMembersSelect?.options || [])
          .find((item) => item.value === name);
        addTarget(option);
      }
      return targets;
    },

    showTutorialMacroChainSelection(names = [], { target = this.addBoneChainMembersSelect, status = true } = {}) {
      const selectedValues = [...new Set(names)]
        .filter((name) => this.bones?.has?.(name));
      if (!selectedValues.length) {
        return false;
      }
      this.tutorialMacroScrollTargetIntoView(target);
      this.flashTutorialMacroTarget(target);
      for (const item of this.tutorialMacroChainMemberTargets(selectedValues)) {
        this.flashTutorialMacroTarget(item);
      }
      if (status) {
        const labels = selectedValues.map((name) => this.boneDisplayName?.(name) || name);
        this.setStatus(`Selected chain bones: ${labels.join(" -> ")}`);
      }
      return true;
    },

    restoreTutorialMacroViewportState(state = {}) {
      if (!state || typeof state !== "object") {
        return false;
      }
      const layers = state.viewportLayers && typeof state.viewportLayers === "object"
        ? state.viewportLayers
        : null;
      if (layers) {
        if (layers.rendered !== undefined) this.showRenderedLayer = Boolean(layers.rendered);
        if (layers.mesh !== undefined) this.showMeshLayer = Boolean(layers.mesh);
        if (layers.selection !== undefined) this.showSelectionLayer = Boolean(layers.selection);
        if (layers.bones !== undefined) this.showBonesLayer = Boolean(layers.bones);
      }
      const hasCleanPreview = state.cleanPreview !== undefined || state.gizmoOnlyPreview !== undefined;
      if (state.gizmoOnlyPreview) {
        this.setGizmoOnlyPreview?.(true);
      } else if (hasCleanPreview) {
        this.setCleanPreview?.(Boolean(state.cleanPreview));
      } else if (layers || state.viewMode) {
        this.setViewMode?.(state.viewMode || this.viewMode, { silent: true, preserveViewportLayers: true });
      }
      if (state.viewMode && state.viewMode !== this.viewMode) {
        this.setViewMode?.(state.viewMode, { silent: true, preserveViewportLayers: true });
      }
      this.syncViewportLayerButtons?.();
      return Boolean(hasCleanPreview || layers || state.viewMode);
    },

    async showTutorialMacroTargetClick(target, duration = 120) {
      if (target) {
        this.tutorialMacroScrollTargetIntoView(target);
        await delay(45 / this.tutorialMacroPlaybackSpeed());
      }
      const rect = target?.getBoundingClientRect?.();
      if (!rect) {
        return false;
      }
      this.moveTutorialMacroPointerTo({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      }, { click: true });
      this.flashTutorialMacroTarget(target);
      await delay(duration / this.tutorialMacroPlaybackSpeed());
      return true;
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

    tutorialMacroPointerCaptureShim() {
      const element = this.canvas;
      if (!element) {
        return () => {};
      }
      const originalSetPointerCapture = element.setPointerCapture;
      const originalReleasePointerCapture = element.releasePointerCapture;
      const originalHasPointerCapture = element.hasPointerCapture;
      try {
        element.setPointerCapture = () => {};
        element.releasePointerCapture = () => {};
        element.hasPointerCapture = (pointerId) => (
          pointerId === MACRO_POINTER_ID
          || (typeof originalHasPointerCapture === "function" && originalHasPointerCapture.call(element, pointerId))
        );
      } catch {
        return () => {};
      }
      return () => {
        try {
          element.setPointerCapture = originalSetPointerCapture;
          element.releasePointerCapture = originalReleasePointerCapture;
          element.hasPointerCapture = originalHasPointerCapture;
        } catch {
          // Ignore restore failures on unusual browser-owned element wrappers.
        }
      };
    },

    dispatchTutorialMacroPointerEvent(event) {
      const point = this.tutorialMacroCanvasPoint(event);
      if (!point || !this.canvas) {
        return false;
      }
      if (event.kind === "wheel") {
        this.canvas.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: point.x,
          clientY: point.y,
          deltaX: Number(event.deltaX || 0),
          deltaY: Number(event.deltaY || 0) || 1
        }));
        return true;
      }
      const type = event.kind === "move"
        ? "pointermove"
        : event.kind === "up" ? "pointerup" : "pointerdown";
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: Number(event.button || 0),
        buttons: event.kind === "up" ? 0 : Number(event.buttons || 1),
        clientX: point.x,
        clientY: point.y,
        pointerId: MACRO_POINTER_ID,
        pointerType: "mouse",
        isPrimary: true
      };
      const pointerEvent = new PointerEvent(type, init);
      if (event.brush) {
        Object.defineProperty(pointerEvent, "tutorialMacroBrush", {
          configurable: true,
          value: event.brush
        });
      }
      const restorePointerCapture = this.tutorialMacroPointerCaptureShim();
      try {
        this.canvas.dispatchEvent(pointerEvent);
      } finally {
        restorePointerCapture();
      }
      if (event.kind === "up") {
        const windowEvent = new PointerEvent(type, init);
        if (event.brush) {
          Object.defineProperty(windowEvent, "tutorialMacroBrush", {
            configurable: true,
            value: event.brush
          });
        }
        window.dispatchEvent(windowEvent);
      }
      return true;
    },

    restoreTutorialMacroPoseState(state = {}) {
      if (!state || !this.model) {
        return false;
      }
      this.restoreTutorialMacroViewportState?.(state);
      if (Number.isFinite(Number(state.progress))) {
        this.progress = clamp01(Number(state.progress));
        if (this.timeScrub) {
          this.timeScrub.value = String(this.progress);
        }
      }
      if (Array.isArray(state.poseKeyframes)) {
        this.applySerializedPoseKeyframes?.(state.poseKeyframes, { preserveCurveHandles: true });
        this.applySerializedPoseCurveHandles?.(state.poseCurveHandles || []);
      }
      this.poseKeyframeMode = state.poseKeyframeMode === "replace" ? "replace" : "additive";
      this.poseKeyframesGenerated = Boolean(state.poseKeyframesGenerated);
      this.timelineKeysSourceWasAutoGenerated = Boolean(state.timelineKeysSourceWasAutoGenerated);
      if (Array.isArray(state.adaptivePoseKeyframes)) {
        this.adaptivePoseKeyframes = this.serializedPoseKeyframeMap?.(state.adaptivePoseKeyframes) || new Map();
      }
      this.adaptiveGuideKeyframes = Array.isArray(state.adaptiveGuideKeyframes)
        ? this.serializedPoseKeyframeMap?.(state.adaptiveGuideKeyframes) || new Map()
        : new Map();
      this.adaptiveGuideDeltaKeyframes = Array.isArray(state.adaptiveGuideDeltaKeyframes)
        ? this.serializedPoseKeyframeMap?.(state.adaptiveGuideDeltaKeyframes) || new Map()
        : new Map();
      this.manualPose = new Map((state.manualPose || [])
        .filter(([name]) => this.bones.has(name))
        .map(([name, pose]) => [name, { ...pose }]));
      this.manualPoseAdditiveNames = new Set((state.manualPoseAdditiveNames || [])
        .filter((name) => this.manualPose.has(name)));
      this.manualPoseEditedChannels = new Map((state.manualPoseEditedChannels || [])
        .filter(([name]) => this.bones.has(name))
        .map(([name, channels]) => [name, new Set(channels || [])]));
      if (this.addBoneChainMembersSelect && Array.isArray(state.selectedChainMembers)) {
        const selected = new Set(state.selectedChainMembers.filter((name) => this.bones.has(name)));
        for (const option of Array.from(this.addBoneChainMembersSelect.options || [])) {
          option.selected = selected.has(option.value);
        }
        this.syncSelectedBoneChainFromMemberSelect?.();
      }
      if (state.poseBoneName && this.poseBoneSelect && this.bones.has(state.poseBoneName)) {
        this.poseBoneSelect.value = state.poseBoneName;
      }
      if (state.activeBoneName && this.bones.has(state.activeBoneName)) {
        this.setActiveBone?.(state.activeBoneName, {
          suppressBoneChainAutoSelect: true,
          preserveBoneChainMemberSelection: true
        });
      }
      this.restorePoseGizmoMode?.(state.poseGizmoMode || "");
      this.syncTimelineControls?.();
      this.applyPose(this.progress);
      this.model?.updateMatrixWorld(true);
      for (const record of this.paintRecords || []) {
        record.object?.skeleton?.update?.();
      }
      this.syncPoseControlsToCurrentBone?.();
      this.updateTimelineKeyMarkers?.();
      this.updateBoneLayerValues?.({ force: true });
      this.updateSelectedBoneHighlight?.();
      this.updateBonePickerOverlay?.();
      this.updateRigBoneList?.();
      this.restoreTutorialMacroViewportState?.(state);
      return true;
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
      const previousApplyingEvent = Boolean(this.tutorialMacroApplyingEvent);
      this.tutorialMacroApplyingEvent = true;
      try {
      if (event.type === "tool") {
        const target = event.selector ? document.querySelector(event.selector) : null;
        await this.showTutorialMacroTargetClick(target, 140);
        this.setTool?.(event.tool || "orbit", { preserveViewportLayers: true });
        return;
      }
      if (event.type === "brush") {
        this.applyTutorialMacroBrushSettings?.(event.settings);
        return;
      }
      if (event.type === "ui") {
        const target = event.selector ? document.querySelector(event.selector) : null;
        await this.showTutorialMacroTargetClick(target, 120);
        if (!target || target.disabled) {
          return;
        }
        const tool = target.dataset?.tool || "";
        if (tool) {
          this.setTool?.(tool, { preserveViewportLayers: true });
          this.flashTutorialMacroTarget(target);
          return;
        }
        if (target.id === "bone-gizmo") {
          this.toggleActiveBoneMoveGizmo?.();
          this.flashTutorialMacroTarget(target);
          return;
        }
        if (target.id === "ik-gizmo") {
          this.toggleIkMoveGizmo?.();
          this.flashTutorialMacroTarget(target);
          return;
        }
        if (event.viewportToggle === "clean-preview") {
          this.setCleanPreview?.(Boolean(event.cleanPreview));
          this.flashTutorialMacroTarget(target);
          return;
        }
        if (event.viewportToggle === "gizmo-only-preview") {
          this.setGizmoOnlyPreview?.(Boolean(event.gizmoOnlyPreview));
          this.flashTutorialMacroTarget(target);
          return;
        }
        if (event.tag === "select" || event.tag === "input") {
          if (event.tag === "select" && target.multiple && Array.isArray(event.selectedValues)) {
            const selected = new Set(event.selectedValues.map((value) => String(value)));
            for (const option of Array.from(target.options || [])) {
              option.selected = selected.has(String(option.value));
            }
            if (target === this.addBoneChainMembersSelect) {
              this.syncSelectedBoneChainFromMemberSelect?.();
              this.showTutorialMacroChainSelection?.(event.selectedValues.map(String), { target });
              return;
            }
          } else if (event.value !== undefined) {
            target.value = String(event.value);
          }
          if (event.inputType === "checkbox" || event.inputType === "radio") {
            target.checked = Boolean(event.checked);
          }
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        target.click?.();
        await this.waitForTutorialMacroRestoreIdle?.({
          timeoutMs: target.id === "undo-edit" || target.id === "redo-edit" ? 5200 : 1800
        });
        return;
      }
      if (event.type === "chain-selection") {
        const target = event.selector ? document.querySelector(event.selector) : this.addBoneChainMembersSelect;
        await this.showTutorialMacroTargetClick(target, 120);
        if (!target || target.disabled || !Array.isArray(event.selectedValues)) {
          return;
        }
        const selected = new Set(event.selectedValues.map((value) => String(value)));
        for (const option of Array.from(target.options || [])) {
          option.selected = selected.has(String(option.value));
        }
        this.syncSelectedBoneChainFromMemberSelect?.();
        this.showTutorialMacroChainSelection?.(event.selectedValues.map(String), { target });
        return;
      }
      if (event.type === "camera") {
        const travelFollowActive = this.travelLoopToggle?.checked === true && this.travelFollowToggle?.checked === true;
        if (travelFollowActive || event.reason === "travel-follow" || event.reason === "camera-pan") {
          return;
        }
        const duration = Math.min(140, Math.max(40, (nextEvent?.t || event.t + 90) - event.t));
        await this.animateTutorialMacroCameraTo(event.camera, duration / this.tutorialMacroPlaybackSpeed());
        return;
      }
      if (event.type === "state") {
        this.restoreTutorialMacroViewportState?.(event.state);
        return;
      }
      if (event.type === "pose-state") {
        this.restoreTutorialMacroPoseState?.(event.state);
        return;
      }
      if (event.type !== "pointer") {
        return;
      }
      const point = this.tutorialMacroCanvasPoint(event);
      this.moveTutorialMacroPointerTo(point, {
        down: event.kind !== "up" && event.kind !== "wheel",
        click: event.kind === "down" || event.kind === "up"
      });
      if (event.kind === "wheel" || event.tool === "orbit") {
        this.dispatchTutorialMacroPointerEvent(event);
        return;
      }
      if (event.tool && this.activeTool !== event.tool) {
        this.setTool?.(event.tool, { preserveViewportLayers: true });
      }
      if (event.brush) {
        this.applyTutorialMacroBrushSettings?.(event.brush);
      }
      this.dispatchTutorialMacroPointerEvent(event);
      if (event.kind === "up") {
        this.moveTutorialMacroPointerTo(point, { down: false });
        await this.waitForTutorialMacroRestoreIdle?.({ timeoutMs: 1800 });
      }
      } finally {
        this.tutorialMacroApplyingEvent = previousApplyingEvent;
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
      await this.loadPackagedTutorialMacros?.();
      await this.loadTutorialMacrosFromIndexedDb?.();
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
      this.clearTutorialMacroRecordingHighlights?.();
      this.tutorialMacroPlaying = true;
      this.tutorialMacroPlayingName = macroName;
      this.updateTutorialMacroControls?.();
      const token = Symbol("tutorial-macro");
      this.tutorialMacroPlaybackToken = token;
      this.tutorialMacroPlaybackSeekRatio = null;
      this.setTutorialMacroPlaybackBackdrop?.(true);
      this.showTutorialMacroPointer();
      this.setStatus(`Playing ${label} demo`);
      try {
        const events = this.tutorialMacroPlaybackEvents?.(macro) || [...macro.events].sort((left, right) => left.t - right.t);
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
          if (this.shouldSkipTutorialMacroEventForSpeed?.(event, events[index + 1])) {
            previousTime = eventTime || previousTime;
            this.setTutorialMacroScrubRatio(duration ? previousTime / duration : 1);
            index += 1;
            continue;
          }
          const wait = Math.max(0, eventTime - previousTime);
          if (wait) {
            const completedWait = await this.delayTutorialMacroPlayback(wait, token);
            if (!completedWait) {
              continue;
            }
          }
          try {
            await this.applyTutorialMacroEvent(event, events[index + 1]);
          } catch (error) {
            console.warn("Stopped tutorial macro playback after event failed", { index, event, error });
            this.onPointerUp?.();
            this.setStatus(`Stopped ${label} demo at event ${index + 1}`);
            return false;
          }
          previousTime = eventTime || previousTime;
          this.setTutorialMacroScrubRatio(duration ? previousTime / duration : 1);
          index += 1;
        }
        this.onPointerUp?.();
        const completed = this.tutorialMacroPlaying && this.tutorialMacroPlaybackToken === token && index >= events.length;
        if (completed) {
          const remainingDuration = Math.max(0, duration - previousTime);
          if (remainingDuration > 0) {
            const completedWait = await this.delayTutorialMacroPlayback(remainingDuration, token);
            if (!completedWait) {
              return false;
            }
          }
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
        this.stopTutorialMacroScenePlayback?.();
        this.hideTutorialMacroPointer();
        this.setTutorialMacroPlaybackBackdrop?.(false);
        this.updateTutorialMacroControls?.();
      }
    }
  });
}
