import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installAnimationLibraryMethods } from "../src/weight-editor/animation-library.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";
import { installTutorialMacroMethods } from "../src/weight-editor/tutorial-macros.js";

class TestEditor {}
class DemoLibraryEditor {}

installAnimationLibraryMethods(DemoLibraryEditor);
installSceneAndControlMethods(TestEditor, {
  THREE,
  EDIT_ONLY_TOOLS: new Set(["move", "pull", "push"]),
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});
installTutorialMacroMethods(TestEditor, {
  writeJsonFile() {}
});

function classListMock(initial = []) {
  const names = new Set(initial);
  return {
    names,
    add(name) {
      names.add(name);
    },
    remove(...removedNames) {
      for (const name of removedNames) {
        names.delete(name);
      }
    },
    toggle(name, force) {
      const shouldAdd = force === undefined ? !names.has(name) : Boolean(force);
      if (shouldAdd) {
        names.add(name);
      } else {
        names.delete(name);
      }
      return shouldAdd;
    },
    contains(name) {
      return names.has(name);
    }
  };
}

function buttonMock() {
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    listeners: new Map(),
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    },
    click() {
      this.listeners.get("click")?.();
    }
  };
}

function withWindowSearch(t, search) {
  const originalWindow = globalThis.window;
  const store = new Map();
  globalThis.window = {
    location: { search },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      }
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  return store;
}

test("tutorial repro macro URL enables the existing help macro recorder", (t) => {
  const store = withWindowSearch(t, "?reproMacro=after orbit paint!");
  const editor = new TestEditor();

  assert.equal(editor.tutorialReproMacroNameFromBrowser(), "after-orbit-paint");
  assert.equal(editor.tutorialEditorEnabledForBrowser(), true);
  assert.equal(store.size, 0);
});

test("afterOrbitPaint URL opens the existing after-orbit paint repro macro", (t) => {
  withWindowSearch(t, "?library=server&afterOrbitPaint=20260623c");
  const editor = new TestEditor();

  assert.equal(editor.tutorialReproMacroNameFromBrowser(), "after-orbit-paint");
  assert.equal(editor.tutorialEditorEnabledForBrowser(), true);
});

test("neighborSeedRecover URL opens the after-orbit recorder lane", (t) => {
  withWindowSearch(t, "?library=server&neighborSeedRecover=20260623b&debugRun=1");
  const editor = new TestEditor();
  const recordingBar = {
    hidden: true,
    classList: classListMock()
  };
  const recordButton = buttonMock();
  const playButton = buttonMock();
  const exportButton = buttonMock();
  const stopButton = buttonMock();
  editor.tutorialMacroRecordingBar = recordingBar;
  editor.reproMacroRecordButton = recordButton;
  editor.reproMacroPlayButton = playButton;
  editor.reproMacroExportButton = exportButton;
  editor.tutorialMacroFloatingStopButton = stopButton;
  editor.tutorialMacroModeActive = () => true;
  editor.hasTutorialMacro = (name) => name === "after-orbit-paint";
  editor.savedTutorialMacroNames = () => ["after-orbit-paint"];

  editor.updateTutorialMacroControls();

  assert.equal(editor.tutorialReproMacroNameFromBrowser(), "after-orbit-paint");
  assert.equal(editor.tutorialEditorEnabledForBrowser(), true);
  assert.equal(recordingBar.hidden, false);
  assert.equal(recordButton.hidden, false);
  assert.equal(recordButton.disabled, false);
  assert.equal(playButton.hidden, false);
  assert.equal(playButton.disabled, false);
  assert.equal(exportButton.disabled, false);
  assert.equal(stopButton.hidden, true);
});

test("activateTutorialReproMacro selects the viewport macro recorder lane", (t) => {
  withWindowSearch(t, "?reproMacro=after-orbit-paint");
  const editor = new TestEditor();
  const card = { classList: classListMock() };
  const source = {
    classList: classListMock(),
    closest(selector) {
      return selector === ".tutorial-card" ? card : null;
    }
  };
  let attachedSource = null;
  let drawerOpen = false;
  let controlsUpdated = false;
  let preparedMacro = null;
  editor.tutorialDrawer = {
    querySelector(selector) {
      return selector === '[data-tutorial-macro="airbrush"]' ? source : null;
    }
  };
  editor.attachTutorialDemoControls = (target) => {
    attachedSource = target;
    return true;
  };
  editor.setTutorialDrawerOpen = (open) => {
    drawerOpen = open;
  };
  editor.updateTutorialMacroControls = () => {
    controlsUpdated = true;
  };
  editor.prepareTutorialReproMacroBrushState = (name) => {
    preparedMacro = name;
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.activateTutorialReproMacro("ignored"), true);
  assert.equal(editor.tutorialActiveMacroName, "after-orbit-paint");
  assert.equal(preparedMacro, "after-orbit-paint");
  assert.equal(attachedSource, source);
  assert.equal(drawerOpen, false);
  assert.equal(controlsUpdated, true);
  assert.match(editor.lastStatus, /after-orbit-paint/);
});

test("activateTutorialReproMacro enables Neighbor from any recorded macro brush state", (t) => {
  withWindowSearch(t, "?reproMacro=custom-neighbor-repro");
  const editor = new TestEditor();
  const card = { classList: classListMock() };
  const source = {
    classList: classListMock(),
    closest(selector) {
      return selector === ".tutorial-card" ? card : null;
    }
  };
  let attachedSource = null;
  let neighborEnabled = null;
  editor.tutorialDrawer = {
    querySelector(selector) {
      return selector === '[data-tutorial-macro="airbrush"]' ? source : null;
    }
  };
  editor.attachTutorialDemoControls = (target) => {
    attachedSource = target;
    return true;
  };
  editor.updateTutorialMacroControls = () => {};
  editor.setTexturePaintNeighborMode = (enabled, options) => {
    neighborEnabled = { enabled, options };
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  editor.storeTutorialMacros({
    "custom-neighbor-repro": {
      name: "custom-neighbor-repro",
      events: [{
        t: 0,
        type: "tool",
        tool: "airbrush"
      }, {
        t: 1,
        type: "brush",
        settings: { opacity: 0.42, neighbor: true }
      }, {
        t: 2,
        type: "pointer",
        kind: "down",
        tool: "airbrush",
        brush: { opacity: 0.42, neighbor: true }
      }]
    }
  });

  assert.equal(editor.activateTutorialReproMacro("ignored"), true);
  assert.equal(editor.tutorialActiveMacroName, "custom-neighbor-repro");
  assert.deepEqual(neighborEnabled, { enabled: true, options: { status: false } });
  assert.equal(attachedSource, source);
  assert.match(editor.lastStatus, /custom-neighbor-repro/);
});

test("activateTutorialReproMacro applies an explicit recorded Neighbor-off state", (t) => {
  withWindowSearch(t, "?reproMacro=custom-plain-airbrush");
  const editor = new TestEditor();
  let neighborEnabled = null;
  editor.tutorialDrawer = {
    querySelector() {
      return null;
    }
  };
  editor.updateTutorialMacroControls = () => {};
  editor.setTexturePaintNeighborMode = (enabled, options) => {
    neighborEnabled = { enabled, options };
  };
  editor.setStatus = () => {};
  editor.storeTutorialMacros({
    "custom-plain-airbrush": {
      name: "custom-plain-airbrush",
      events: [{
        t: 0,
        type: "tool",
        tool: "airbrush"
      }, {
        t: 1,
        type: "brush",
        settings: { opacity: 0.42, neighbor: false }
      }]
    }
  });

  assert.equal(editor.activateTutorialReproMacro("ignored"), true);
  assert.deepEqual(neighborEnabled, { enabled: false, options: { status: false } });
});

test("viewport repro macro play uses the current loaded scene", (t) => {
  withWindowSearch(t, "?reproMacro=after-orbit-paint");
  const editor = new TestEditor();
  const playButton = buttonMock();
  editor.reproMacroPlayButton = playButton;
  editor.reproMacroRecordButton = buttonMock();
  editor.reproMacroExportButton = buttonMock();
  editor.tutorialMacroFloatingStopButton = buttonMock();
  editor.tutorialReproMacroActive = true;
  editor.tutorialActiveMacroName = "after-orbit-paint";
  editor.tutorialMacroModeActive = () => true;
  editor.hasTutorialMacro = (name) => name === "after-orbit-paint";
  editor.savedTutorialMacroNames = () => ["after-orbit-paint"];
  editor.model = {};
  editor.canvas = {};
  editor.paintRecords = [{
    object: {
      geometry: {
        attributes: {
          position: {},
          uv: {}
        }
      }
    }
  }];
  editor.loadPackagedTutorialMacros = async () => {};
  editor.loadTutorialMacrosFromIndexedDb = async () => {};
  let played = null;
  editor.playTutorialMacro = (name, options) => {
    played = { name, options };
  };

  editor.bindTutorialMacroControls();
  editor.updateTutorialMacroControls();

  assert.equal(playButton.hidden, false);
  assert.equal(playButton.disabled, false);
  assert.equal(playButton.textContent, "Play");
  playButton.click();
  assert.deepEqual(played, {
    name: "after-orbit-paint",
    options: {
      preservePointerMoves: true,
      resetDemo: false,
      requireCurrentScene: true
    }
  });
});

test("viewport repro macro play loads the demo when no scene is loaded", (t) => {
  withWindowSearch(t, "?reproMacro=after-orbit-paint");
  const editor = new TestEditor();
  const playButton = buttonMock();
  editor.reproMacroPlayButton = playButton;
  editor.reproMacroRecordButton = buttonMock();
  editor.reproMacroExportButton = buttonMock();
  editor.tutorialMacroFloatingStopButton = buttonMock();
  editor.tutorialReproMacroActive = true;
  editor.tutorialActiveMacroName = "after-orbit-paint";
  editor.tutorialMacroModeActive = () => true;
  editor.hasTutorialMacro = (name) => name === "after-orbit-paint";
  editor.savedTutorialMacroNames = () => ["after-orbit-paint"];
  editor.loadPackagedTutorialMacros = async () => {};
  editor.loadTutorialMacrosFromIndexedDb = async () => {};
  let played = null;
  editor.playTutorialMacro = (name, options) => {
    played = { name, options };
  };

  editor.bindTutorialMacroControls();
  editor.updateTutorialMacroControls();

  assert.equal(playButton.hidden, false);
  assert.equal(playButton.disabled, false);
  assert.equal(playButton.textContent, "Play");
  playButton.click();
  assert.deepEqual(played, {
    name: "after-orbit-paint",
    options: {
      preservePointerMoves: true,
      resetDemo: true,
      requireCurrentScene: false
    }
  });
});

test("tutorial macro orbit event reenables controls after texture paint", async (t) => {
  withWindowSearch(t, "");
  const originalPointerEvent = globalThis.PointerEvent;
  globalThis.PointerEvent = class PointerEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  t.after(() => {
    globalThis.PointerEvent = originalPointerEvent;
  });

  const editor = new TestEditor();
  const dispatched = [];
  const toolCalls = [];
  editor.tutorialMacroPlaying = true;
  editor.activeTool = "airbrush";
  editor.controls = { enabled: false };
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 200, height: 100 };
    },
    dispatchEvent(event) {
      dispatched.push({
        type: event.type,
        activeTool: editor.activeTool,
        controlsEnabled: editor.controls.enabled
      });
      return true;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() {
      return false;
    }
  };
  editor.moveTutorialMacroPointerTo = () => {};
  editor.setTool = (tool, options) => {
    toolCalls.push({ tool, options });
    editor.activeTool = tool;
    editor.controls.enabled = tool === "orbit" || tool === "bone";
  };

  await editor.applyTutorialMacroEvent({
    type: "pointer",
    kind: "down",
    tool: "orbit",
    x: 0.5,
    y: 0.5,
    button: 0,
    buttons: 1
  });

  assert.deepEqual(toolCalls, [{
    tool: "orbit",
    options: { preserveViewportLayers: true }
  }]);
  assert.deepEqual(dispatched, [{
    type: "pointerdown",
    activeTool: "orbit",
    controlsEnabled: true
  }]);
});

test("tutorial macro dispatch keeps reconstructed Hermite spans in one pointer batch", (t) => {
  withWindowSearch(t, "");
  const originalPointerEvent = globalThis.PointerEvent;
  globalThis.PointerEvent = class PointerEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  t.after(() => {
    globalThis.PointerEvent = originalPointerEvent;
  });

  const editor = new TestEditor();
  let dispatched = null;
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 200, height: 100 };
    },
    dispatchEvent(event) {
      dispatched = event;
      return true;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() {
      return false;
    }
  };

  assert.equal(editor.dispatchTutorialMacroPointerEvent({
    type: "pointer",
    kind: "move",
    tool: "airbrush",
    x: 0.75,
    y: 0.8,
    button: 0,
    buttons: 1,
    brush: { pressure: 0.7, pressureRadius: true },
    macroCoalesced: [
      { type: "pointer", kind: "move", tool: "airbrush", x: 0.25, y: 0.4, buttons: 1, brush: { pressure: 0.3, pressureRadius: true } },
      { type: "pointer", kind: "move", tool: "airbrush", x: 0.5, y: 0.6, buttons: 1, brush: { pressure: 0.5, pressureRadius: true } }
    ]
  }), true);

  assert.equal(dispatched.type, "pointermove");
  assert.equal(typeof dispatched.getCoalescedEvents, "function");
  assert.deepEqual(
    dispatched.getCoalescedEvents().map((event) => [event.clientX, event.clientY]),
    [[60, 60], [110, 80], [160, 100]]
  );
  assert.deepEqual(
    dispatched.getCoalescedEvents().map((event) => [event.pointerType, event.pressure, event.tutorialMacroBrush?.pressure]),
    [["pen", 0.3, 0.3], ["pen", 0.5, 0.5], ["pen", 0.7, 0.7]]
  );
});

test("viewport repro macro mode enables demo library bootstrap", (t) => {
  withWindowSearch(t, "?reproMacro=after-orbit-paint");
  const editor = new DemoLibraryEditor();

  assert.equal(editor.tutorialDemoAnimationLibraryName(), "");

  editor.tutorialReproMacroActive = true;
  assert.equal(editor.tutorialDemoAnimationLibraryName(), "cat");
});

test("demo model loader does not treat a selected clip as a loaded paintable scene", async (t) => {
  withWindowSearch(t, "?reproMacro=after-orbit-paint");
  const editor = new DemoLibraryEditor();
  editor.tutorialReproMacroActive = true;
  editor.activeClipEntry = { key: "stale-selected-file" };
  editor.animationLibraryFolders = [{
    name: "cat-demo",
    label: "Cat Demo",
    files: [{
      key: "cat-demo:walking-8",
      name: "walking-8.fbx",
      path: "assets/models/animation-library/etes/walking-8.fbx",
      url: "./assets/models/animation-library/etes/walking-8.fbx",
      extension: "fbx"
    }]
  }];
  editor.renderAnimationLibrary = () => {};
  editor.renderCharacterOptions = () => {};
  editor.setStatus = () => {};
  let restored = null;
  editor.restoreAnimationLibraryFile = async (item, options) => {
    restored = { item, options };
    return true;
  };

  assert.equal(await editor.ensureTutorialDemoModelLoaded("cat"), true);
  assert.equal(restored?.item?.name, "walking-8.fbx");
  assert.deepEqual(restored?.options, { statusVerb: "Loaded demo" });
});

test("tutorial macro idle waits for pending airbrush screen paint", async () => {
  const editor = new TestEditor();
  let pending = true;
  let resolveScreenFlush = null;
  const screenFlush = new Promise((resolve) => {
    resolveScreenFlush = resolve;
  });
  editor.textureAirbrushScreenStrokeHasPendingWork = () => pending;
  editor.finishTextureAirbrushScreenStrokeFlush = () => screenFlush;

  let settled = false;
  const idle = editor.waitForTutorialMacroRestoreIdle({ timeoutMs: 1200 }).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  pending = false;
  resolveScreenFlush();
  assert.equal(await idle, true);
  assert.equal(settled, true);
});

test("tutorial macro brush settings preserve Neighbor paint mode", () => {
  const editor = new TestEditor();
  const dispatched = [];
  editor.texturePaintColor = { value: "#c06f4f", dispatchEvent(event) { dispatched.push(["color", event.type]); } };
  editor.textureBrushRadius = { value: "0.035", dispatchEvent(event) { dispatched.push(["radius", event.type]); } };
  editor.textureBrushSpacing = { value: "1", dispatchEvent(event) { dispatched.push(["spacing", event.type]); } };
  editor.textureBrushOpacity = { value: "0.42", dispatchEvent(event) { dispatched.push(["opacity", event.type]); } };
  editor.textureBrushHardness = { value: "0.35", dispatchEvent(event) { dispatched.push(["hardness", event.type]); } };
  editor.textureVisibleEdgeMode = { value: "soft", dispatchEvent(event) { dispatched.push(["edge", event.type]); } };
  editor.textureBrushScatter = { value: "0.35", dispatchEvent(event) { dispatched.push(["scatter", event.type]); } };
  editor.texturePaintNeighborEnabled = true;
  editor.texturePaintNeighborModeEnabled = () => editor.texturePaintNeighborEnabled === true;
  editor.textureAirbrushColor = () => ({ r: 192, g: 111, b: 79 });
  editor.textureAirbrushPressureValue = () => 1;
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureAirbrushVisibleEdgeMode = () => editor.textureVisibleEdgeMode.value === "hard" ? "hard" : "soft";
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.updateRangeOutputs = () => {};
  const neighborModeCalls = [];
  editor.setTexturePaintNeighborMode = (enabled) => {
    neighborModeCalls.push(enabled === true);
    editor.texturePaintNeighborEnabled = enabled === true;
  };

  const snapshot = editor.tutorialMacroBrushSettingsSnapshot();
  assert.equal(snapshot.neighbor, true);
  assert.equal(snapshot.visibleEdgeMode, "soft");
  assert.equal(editor.applyTutorialMacroBrushSettings({ neighbor: true }), true);
  assert.deepEqual(neighborModeCalls, []);

  assert.equal(editor.applyTutorialMacroBrushSettings({ neighbor: false }), true);
  assert.equal(editor.texturePaintNeighborEnabled, false);
  assert.deepEqual(neighborModeCalls, [false]);

  assert.equal(editor.applyTutorialMacroBrushSettings({ neighbor: true }), true);
  assert.equal(editor.texturePaintNeighborEnabled, true);
  assert.deepEqual(neighborModeCalls, [false, true]);
  assert.equal(editor.applyTutorialMacroBrushSettings({ visibleEdgeMode: "hard" }), true);
  assert.equal(editor.textureVisibleEdgeMode.value, "hard");
  assert.deepEqual(dispatched, [["edge", "input"], ["edge", "change"]]);
});

test("recorded texture brush events carry the live Neighbor paint mode", () => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.canvas = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 100 };
    }
  };
  editor.tutorialMacroRecording = {
    name: "custom-neighbor-repro",
    startTime: 0,
    events: [],
    lastPointerTime: -Infinity
  };
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.textureAirbrushColor = () => ({ r: 192, g: 111, b: 79 });

  assert.equal(editor.recordTutorialMacroPointer("down", {
    clientX: 80,
    clientY: 20,
    button: 0,
    buttons: 1
  }), true);

  const event = editor.tutorialMacroRecording.events[0];
  assert.equal(event.type, "pointer");
  assert.equal(event.tool, "airbrush");
  assert.equal(event.brush.neighbor, true);
  const paintBrush = editor.recordTutorialMacroPaintBrushState();
  assert.equal(paintBrush.neighbor, true);
  assert.equal(event.brushSource, "paint");
  assert.equal(event.brush.neighbor, true);
});

test("after-orbit repro macros default old brush events to Neighbor on", (t) => {
  withWindowSearch(t, "");
  const editor = new TestEditor();
  editor.tutorialEditorEnabled = true;

  assert.equal(editor.storeTutorialMacros({
    "after-orbit-paint": {
      name: "after-orbit-paint",
      events: [{
        t: 0,
        type: "brush",
        settings: { opacity: 0.42 }
      }, {
        t: 1,
        type: "pointer",
        kind: "down",
        brush: { opacity: 0.42 }
      }, {
        t: 2,
        type: "pointer",
        kind: "up",
        brush: { opacity: 0.42, neighbor: false }
      }]
    },
    airbrush: {
      name: "airbrush",
      events: [{
        t: 0,
        type: "brush",
        settings: { opacity: 0.42 }
      }]
    }
  }), true);

  const afterOrbit = editor.tutorialMacro("after-orbit-paint");
  assert.equal(afterOrbit.events[0].settings.neighbor, true);
  assert.equal(afterOrbit.events[1].brush.neighbor, true);
  assert.equal(afterOrbit.events[2].brush.neighbor, false);

  const ordinary = editor.tutorialMacro("airbrush");
  assert.equal(ordinary.events[0].settings.neighbor, undefined);
});

test("packaged after-orbit repro macro keeps a Neighbor paint stroke and orbit repro", (t) => {
  withWindowSearch(t, "");
  const editor = new TestEditor();
  editor.tutorialEditorEnabled = true;
  const payload = JSON.parse(fs.readFileSync(new URL("../assets/tutorial-macros.json", import.meta.url), "utf8"));

  assert.equal(editor.storeTutorialMacros(payload.macros), true);
  const macro = editor.tutorialMacro("after-orbit-paint");
  const strokes = [];
  let activeStroke = null;
  for (const [index, event] of macro.events.entries()) {
    if (event.type !== "pointer") {
      continue;
    }
    if (event.kind === "down") {
      activeStroke = {
        start: index,
        end: null,
        tool: event.tool,
        neighbor: event.brush?.neighbor,
        moves: 0
      };
    } else if (event.kind === "move" && activeStroke) {
      activeStroke.moves += 1;
    } else if (event.kind === "up" && activeStroke) {
      activeStroke.end = index;
      strokes.push(activeStroke);
      activeStroke = null;
    }
  }

  assert.ok(strokes.length >= 2);
  const neighborPaintStrokes = strokes.filter((stroke) => stroke.tool === "airbrush");
  assert.equal(neighborPaintStrokes.length, 1);
  assert.ok(neighborPaintStrokes[0].moves > 20);
  assert.equal(neighborPaintStrokes[0].neighbor, true);
  assert.ok(strokes.some((stroke) => (
    stroke.tool === "orbit"
    && stroke.start > neighborPaintStrokes[0].end
  )));
  assert.ok(macro.events.some((event) => event.type === "camera" && event.reason === "camera"));
});

test("airbrush overlap repro macro playback preserves bounded smoothed pointer paths", (t) => {
  withWindowSearch(t, "?reproMacro=airbrush-zigzag-stroke");
  const editor = new TestEditor();
  const payload = JSON.parse(fs.readFileSync(new URL("../assets/tutorial-macros.json", import.meta.url), "utf8"));

  assert.equal(editor.storeTutorialMacros(payload.macros), true);
  const macro = editor.tutorialMacro("airbrush-zigzag-stroke");
  const originalPointerCount = macro.events.filter((event) => event.type === "pointer").length;
  const events = editor.tutorialMacroPlaybackEvents(macro);
  const pointerEvents = events.filter((event) => event.type === "pointer");
  const smoothedEvents = pointerEvents.flatMap((event) => event.macroCoalesced || []);
  const hermiteEvents = smoothedEvents.filter((event) => event.macroHermite === true);
  const expandedPointerEvents = pointerEvents.flatMap((event) => [
    ...(event.macroCoalesced || []),
    event
  ]);

  assert.equal(pointerEvents.length, originalPointerCount);
  assert.ok(smoothedEvents.length > 0);
  assert.ok(hermiteEvents.length > 0);
  assert.equal(hermiteEvents.length, smoothedEvents.length);
  assert.ok(pointerEvents.every((event) => (
    !event.macroCoalesced || (event.kind === "move" && event.macroCoalesced.length > 0)
  )));

  let previousRecordedPointer = null;
  for (const event of pointerEvents) {
    if (event.tool !== "airbrush" || event.kind === "wheel") {
      previousRecordedPointer = null;
      continue;
    }
    if (event.kind === "down") {
      previousRecordedPointer = event;
      continue;
    }
    if (!previousRecordedPointer || event.kind !== "move" || !event.macroCoalesced?.length) {
      previousRecordedPointer = event.kind === "up" ? null : event;
      continue;
    }
    const chordX = event.x - previousRecordedPointer.x;
    const chordY = event.y - previousRecordedPointer.y;
    const chordLengthSq = chordX * chordX + chordY * chordY;
    let previousProjection = 0;
    for (const sample of event.macroCoalesced) {
      const projection = chordLengthSq > 0
        ? ((sample.x - previousRecordedPointer.x) * chordX + (sample.y - previousRecordedPointer.y) * chordY) / chordLengthSq
        : 0;
      assert.ok(projection >= previousProjection - 0.0001);
      assert.ok(projection <= 1.0001);
      previousProjection = projection;
    }
    previousRecordedPointer = event;
  }

  let activeStroke = null;
  const strokes = [];
  for (const event of expandedPointerEvents) {
    if (event.kind === "down" && event.tool === "airbrush") {
      activeStroke = [event];
    } else if (activeStroke) {
      activeStroke.push(event);
      if (event.kind === "up") {
        strokes.push(activeStroke);
        activeStroke = null;
      }
    }
  }

  assert.equal(
    strokes.length,
    pointerEvents.filter((event) => event.kind === "down" && event.tool === "airbrush").length
  );
  let maxGap = 0;
  let maxStep = 0;
  for (const stroke of strokes) {
    for (let index = 1; index < stroke.length; index += 1) {
      const previous = stroke[index - 1];
      const current = stroke[index];
      maxGap = Math.max(maxGap, Number(current.t) - Number(previous.t));
      if (current.kind === "move") {
        maxStep = Math.max(
          maxStep,
          Math.hypot(Number(current.x) - Number(previous.x), Number(current.y) - Number(previous.y))
        );
      }
    }
    assert.equal(stroke.at(-1).kind, "up");
  }

  assert.ok(maxGap <= 80);
  assert.ok(maxStep <= 0.0065);
  assert.ok(events.at(-1).t < macro.events.at(-1).t);
});

test("closing help while repro recording keeps the macro recorder alive", (t) => {
  withWindowSearch(t, "?reproMacro=after-orbit-paint");
  const editor = new TestEditor();
  const drawerClassList = classListMock(["is-open"]);
  const backdropClassList = classListMock(["is-open", "is-macro-recording"]);
  let endedSession = false;
  let clearedHighlights = false;
  let controlsUpdated = false;
  editor.tutorialReproMacroActive = true;
  editor.tutorialMacroRecording = { name: "after-orbit-paint" };
  editor.tutorialDrawerOpen = true;
  editor.tutorialDrawer = {
    hidden: false,
    classList: drawerClassList,
    setAttribute(name, value) {
      editor.drawerAttr = [name, value];
    }
  };
  editor.tutorialBackdrop = {
    hidden: false,
    classList: backdropClassList
  };
  editor.app = { classList: classListMock(["is-tutorial-drawer-open"]) };
  editor.tutorialsToggle = {
    setAttribute(name, value) {
      editor.toggleAttr = [name, value];
    },
    focus() {
      editor.toggleFocused = true;
    }
  };
  editor.queueTutorialViewportResize = () => {};
  editor.clearTutorialHighlights = () => {
    clearedHighlights = true;
  };
  editor.endTutorialSession = () => {
    endedSession = true;
  };
  editor.updateTutorialMacroControls = () => {
    controlsUpdated = true;
  };

  editor.setTutorialDrawerOpen(false);

  assert.equal(editor.tutorialDrawerOpen, false);
  assert.equal(editor.tutorialMacroRecording.name, "after-orbit-paint");
  assert.equal(editor.tutorialReproMacroActive, true);
  assert.equal(endedSession, false);
  assert.equal(clearedHighlights, false);
  assert.equal(controlsUpdated, false);
  assert.deepEqual(editor.drawerAttr, ["aria-hidden", "true"]);
  assert.equal(drawerClassList.contains("is-open"), false);
  assert.equal(backdropClassList.contains("is-macro-recording"), false);
});

test("tutorial macro camera snapshots invalidate airbrush projection like orbit", () => {
  const editor = new TestEditor();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  let controlsUpdates = 0;
  let lightUpdates = 0;
  let cameraChanges = 0;
  editor.camera = camera;
  editor.controls = {
    target: new THREE.Vector3(),
    update() {
      controlsUpdates += 1;
    }
  };
  editor.updateCameraRelativeLights = () => {
    lightUpdates += 1;
  };
  editor.textureAirbrushCameraChanged = () => {
    cameraChanges += 1;
    return true;
  };

  editor.applyTutorialMacroCameraSnapshot({
    position: [1, 2, 3],
    target: [0.25, 1.5, -0.5],
    up: [0, 1, 0],
    zoom: 1.25,
    fov: 37
  });

  assert.deepEqual(camera.position.toArray(), [1, 2, 3]);
  assert.deepEqual(editor.controls.target.toArray(), [0.25, 1.5, -0.5]);
  assert.equal(camera.zoom, 1.25);
  assert.equal(camera.fov, 37);
  assert.equal(controlsUpdates, 1);
  assert.equal(lightUpdates, 1);
  assert.equal(cameraChanges, 1);
});
