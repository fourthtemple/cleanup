import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";
import { installTutorialMacroMethods } from "../src/weight-editor/tutorial-macros.js";

class TestEditor {}

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
  editor.textureBrushScatter = { value: "0.35", dispatchEvent(event) { dispatched.push(["scatter", event.type]); } };
  editor.texturePaintNeighborEnabled = true;
  editor.texturePaintNeighborModeEnabled = () => editor.texturePaintNeighborEnabled === true;
  editor.textureAirbrushColor = () => ({ r: 192, g: 111, b: 79 });
  editor.textureAirbrushPressureValue = () => 1;
  editor.textureAirbrushPressureSettings = () => ({ radius: true, opacity: false });
  editor.textureAirbrushSpacingPercent = () => 1;
  editor.textureBrushRadiusScreenPixels = () => 8;
  editor.updateRangeOutputs = () => {};
  const neighborModeCalls = [];
  editor.setTexturePaintNeighborMode = (enabled) => {
    neighborModeCalls.push(enabled === true);
    editor.texturePaintNeighborEnabled = enabled === true;
  };

  const snapshot = editor.tutorialMacroBrushSettingsSnapshot();
  assert.equal(snapshot.neighbor, true);
  assert.equal(editor.applyTutorialMacroBrushSettings({ neighbor: true }), true);
  assert.deepEqual(neighborModeCalls, []);

  assert.equal(editor.applyTutorialMacroBrushSettings({ neighbor: false }), true);
  assert.equal(editor.texturePaintNeighborEnabled, false);
  assert.deepEqual(neighborModeCalls, [false]);

  assert.equal(editor.applyTutorialMacroBrushSettings({ neighbor: true }), true);
  assert.equal(editor.texturePaintNeighborEnabled, true);
  assert.deepEqual(neighborModeCalls, [false, true]);
  assert.deepEqual(dispatched, []);
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

test("packaged after-orbit repro macro exercises paint, orbit, then paint with Neighbor", (t) => {
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

  assert.ok(strokes.length >= 3);
  const neighborPaintStrokes = strokes.filter((stroke) => stroke.tool === "airbrush");
  assert.equal(neighborPaintStrokes.length, 2);
  assert.ok(neighborPaintStrokes[0].moves > 20);
  assert.ok(neighborPaintStrokes[1].moves > 20);
  assert.equal(neighborPaintStrokes[0].neighbor, true);
  assert.equal(neighborPaintStrokes[1].neighbor, true);
  assert.ok(strokes.some((stroke) => (
    stroke.tool === "orbit"
    && stroke.start > neighborPaintStrokes[0].end
    && stroke.end < neighborPaintStrokes[1].start
  )));
  assert.ok(macro.events.some((event) => event.type === "camera" && event.reason === "camera"));
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
