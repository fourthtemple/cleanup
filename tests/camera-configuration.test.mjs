import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

class TestEditor {}

installSceneAndControlMethods(TestEditor, {
  THREE,
  EDIT_ONLY_TOOLS: new Set(["move", "pull", "push"]),
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});
installPaintToolMethods(TestEditor, {});

const EXPECTED_CAMERA_AIRBRUSH_PREWARM = {
  all: false,
  force: true,
  limit: 1,
  prewarmPaintablesWithoutHit: true,
  warmScreenHitIndex: true,
  warmNeighborTopology: false,
  tslSurfacePrewarmAll: true,
  tslSurfacePrewarmLimit: 1,
  renderCompilePass: true
};

const EXPECTED_LAYER_CAMERA_AIRBRUSH_PREWARM = {
  ...EXPECTED_CAMERA_AIRBRUSH_PREWARM,
  preserveLayerDisplay: true
};

const EXPECTED_DEFERRED_LAYER_AIRBRUSH_PREWARM = {
  all: false,
  immediateLayer: false,
  preserveLayerDisplay: true,
  liveDisplayExternalTexture: false,
  allowPrewarmLiveDisplayMaterialSwap: false,
  limit: 1,
  prewarmPaintablesWithoutHit: true,
  warmScreenHitIndex: true,
  warmNeighborTopology: false,
  tslSurfacePrewarmAll: true,
  tslSurfacePrewarmLimit: 1,
  renderCompilePass: true
};

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

function input(value) {
  return { value: String(value) };
}

function withLocalStorageMock(t) {
  const originalWindow = globalThis.window;
  const store = new Map();
  globalThis.window = {
    location: { search: "" },
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

function editorWithCameraControls() {
  const axisClassList = classListMock(["is-dragging"]);
  const gizmoAttrs = new Map();
  const editor = new TestEditor();
  editor.cameraGizmoVisible = true;
  editor.cameraGizmoToggle = { checked: true };
  editor.resetCameraSettingsButton = { disabled: false };
  editor.cameraGizmoPad = { classList: classListMock(["is-dragging"]) };
  editor.cameraGizmo = {
    hidden: false,
    attrs: gizmoAttrs,
    setAttribute(name, value) {
      gizmoAttrs.set(name, value);
    }
  };
  editor.cameraAmbientLight = input(0.75);
  editor.cameraKeyLight = input(1.25);
  editor.cameraRimLight = input(0.35);
  editor.cameraTextureGain = input(1);
  editor.cameraBackgroundColor = input("#11171c");
  editor.cameraMeshColor = input("#80d8ff");
  editor.applyBackgroundColor = (value) => {
    editor.backgroundColor = value;
  };
  editor.applyMeshColor = (value) => {
    editor.meshColor = value;
  };
  editor.applySceneLighting = () => {
    editor.sceneLightingApplied = true;
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  return { editor, axisClassList, gizmoAttrs };
}

test("applyCameraGizmoVisibility syncs checkbox state and hides the on-canvas gizmo", (t) => {
  const { editor, axisClassList, gizmoAttrs } = editorWithCameraControls();
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === "[data-camera-axis]" ? [{ classList: axisClassList }] : [];
    }
  };
  t.after(() => {
    globalThis.document = originalDocument;
  });

  editor.cameraGizmoDrag = { pointerId: 7 };
  editor.applyCameraGizmoVisibility(false);

  assert.equal(editor.cameraGizmoVisible, false);
  assert.equal(editor.cameraGizmoToggle.checked, false);
  assert.equal(editor.cameraGizmo.hidden, true);
  assert.equal(gizmoAttrs.get("aria-hidden"), "true");
  assert.equal(editor.cameraGizmoPad.classList.contains("is-dragging"), false);
  assert.equal(axisClassList.contains("is-dragging"), false);
  assert.equal(editor.cameraGizmoDrag, null);

  editor.applyCameraGizmoVisibility(true);
  assert.equal(editor.cameraGizmoVisible, true);
  assert.equal(editor.cameraGizmoToggle.checked, true);
  assert.equal(editor.cameraGizmo.hidden, false);
  assert.equal(gizmoAttrs.get("aria-hidden"), "false");
});

test("background tint updates the ground circle with a desaturated HSV color", () => {
  const editor = new TestEditor();
  const floorMaterial = new THREE.MeshBasicMaterial({ color: "#172026" });
  editor.cameraBackgroundColor = input("#11171c");
  editor.renderer = {
    setClearColor() {}
  };
  editor.scene = {
    fog: {
      color: new THREE.Color("#11171c")
    }
  };
  editor.groundFloor = {
    material: floorMaterial
  };

  assert.equal(editor.groundReferenceFloorTint("#11171c"), "#1e2226");
  assert.equal(editor.groundReferenceFloorTint("#6a2048"), "#6c4359");
  editor.applyBackgroundColor("#6a2048");

  assert.equal(editor.backgroundColor, "#6a2048");
  assert.equal(editor.cameraBackgroundColor.value, "#6a2048");
  assert.equal(floorMaterial.color.getHexString(THREE.SRGBColorSpace), "6c4359");
});

test("camera configuration includes and restores gizmo visibility", () => {
  const { editor } = editorWithCameraControls();
  editor.backgroundColor = "#010203";
  editor.meshColor = "#abcdef";
  editor.cameraAmbientLight.value = "1.5";
  editor.cameraKeyLight.value = "2.5";
  editor.cameraRimLight.value = "0.5";
  editor.cameraTextureGain.value = "1.2";
  editor.applyCameraGizmoVisibility(false);

  assert.deepEqual(editor.currentCameraConfigurationSetting(), {
    backgroundColor: "#010203",
    meshColor: "#abcdef",
    ambient: 1.5,
    key: 2.5,
    rim: 0.5,
    texture: 1.2,
    cameraGizmoVisible: false
  });

  const restored = editor.applyCameraConfigurationSetting({
    backgroundColor: "#111111",
    meshColor: "#222222",
    ambient: 0.25,
    key: 0.75,
    rim: 0.1,
    texture: 0.9,
    cameraGizmoVisible: true
  }, { status: false });

  assert.equal(restored, true);
  assert.equal(editor.cameraGizmoVisible, true);
  assert.equal(editor.cameraGizmoToggle.checked, true);
  assert.equal(editor.backgroundColor, "#111111");
  assert.equal(editor.meshColor, "#222222");
  assert.equal(editor.cameraAmbientLight.value, "0.25");
  assert.equal(editor.cameraKeyLight.value, "0.75");
  assert.equal(editor.cameraRimLight.value, "0.1");
  assert.equal(editor.cameraTextureGain.value, "0.9");
  assert.equal(editor.sceneLightingApplied, true);
});

test("camera configuration auto-save writes display preferences without status noise", (t) => {
  const store = withLocalStorageMock(t);
  const { editor } = editorWithCameraControls();
  editor.backgroundColor = "#123456";
  editor.meshColor = "#654321";
  editor.cameraAmbientLight.value = "1.1";
  editor.cameraKeyLight.value = "2.2";
  editor.cameraRimLight.value = "0.6";
  editor.cameraTextureGain.value = "1.18";
  editor.applyCameraGizmoVisibility(false);

  assert.equal(editor.autoSaveCameraConfigurationSetting(), true);
  assert.equal(editor.lastStatus, undefined);
  assert.equal(editor.resetCameraSettingsButton.disabled, false);

  const saved = JSON.parse(store.get("fourth-temple-model-cleanup:camera-configuration:v1"));
  assert.deepEqual(saved, {
    backgroundColor: "#123456",
    meshColor: "#654321",
    ambient: 1.1,
    key: 2.2,
    rim: 0.6,
    texture: 1.18,
    cameraGizmoVisible: false
  });
});

test("saved camera configuration restores as a local user display preference", (t) => {
  const store = withLocalStorageMock(t);
  store.set("fourth-temple-model-cleanup:camera-configuration:v1", JSON.stringify({
    backgroundColor: "#0a0b0c",
    meshColor: "#ddeeff",
    ambient: 0.55,
    key: 1.8,
    rim: 0.22,
    texture: 1.09,
    cameraGizmoVisible: false
  }));
  const { editor } = editorWithCameraControls();

  assert.equal(editor.restoreSavedCameraConfigurationSetting({ status: false }), true);
  assert.equal(editor.lastStatus, undefined);
  assert.equal(editor.backgroundColor, "#0a0b0c");
  assert.equal(editor.meshColor, "#ddeeff");
  assert.equal(editor.cameraAmbientLight.value, "0.55");
  assert.equal(editor.cameraKeyLight.value, "1.8");
  assert.equal(editor.cameraRimLight.value, "0.22");
  assert.equal(editor.cameraTextureGain.value, "1.09");
  assert.equal(editor.cameraGizmoVisible, false);
  assert.equal(editor.sceneLightingApplied, true);
});

test("restoring a saved camera view prewarms airbrush when painting", () => {
  const editor = new TestEditor();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
  const target = new THREE.Vector3();
  let controlsUpdated = 0;
  let lightsUpdated = 0;
  let cursorUpdated = 0;
  const prewarmCalls = [];
  editor.camera = camera;
  editor.controls = {
    target,
    update() {
      controlsUpdated += 1;
    }
  };
  editor.activeTool = "airbrush";
  editor.savedOrbitViewSetting = () => ({
    version: 1,
    cameraPosition: [1, 2, 3],
    cameraUp: [0, 1, 0],
    target: [0.5, 1.5, 0],
    zoom: 1.25,
    fov: 34
  });
  editor.updateCameraRelativeLights = () => {
    lightsUpdated += 1;
  };
  editor.updateBrushCursorForLastPointer = () => {
    cursorUpdated += 1;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };

  assert.equal(editor.restoreSavedOrbitView(), true);
  assert.deepEqual(camera.position.toArray(), [1, 2, 3]);
  assert.deepEqual(target.toArray(), [0.5, 1.5, 0]);
  assert.equal(camera.zoom, 1.25);
  assert.equal(camera.fov, 34);
  assert.equal(controlsUpdated, 1);
  assert.equal(lightsUpdated, 1);
  assert.equal(cursorUpdated, 1);
  assert.deepEqual(prewarmCalls, [[null, null, EXPECTED_CAMERA_AIRBRUSH_PREWARM]]);
});

test("camera changes only prewarm texture airbrush painting tools", () => {
  const editor = new TestEditor();
  const prewarmCalls = [];
  let cursorUpdates = 0;
  editor.updateBrushCursorForLastPointer = () => {
    cursorUpdates += 1;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  editor.activeTool = "paint";
  assert.equal(editor.prewarmTextureAirbrushAfterCameraChange(), false);
  assert.deepEqual(prewarmCalls, []);
  assert.equal(cursorUpdates, 0);

  editor.activeTool = "texture-eraser";
  assert.equal(editor.prewarmTextureAirbrushAfterCameraChange(), true);
  editor.activeTool = "airbrush";
  assert.equal(editor.prewarmTextureAirbrushAfterCameraChange(), true);

  assert.equal(cursorUpdates, 2);
  assert.deepEqual(prewarmCalls, [
    [null, null, EXPECTED_CAMERA_AIRBRUSH_PREWARM],
    [null, null, EXPECTED_CAMERA_AIRBRUSH_PREWARM]
  ]);
});

test("orbit camera changes invalidate airbrush projection without paint prewarm", () => {
  const editor = new TestEditor();
  const prewarmCalls = [];
  let resetFrames = 0;
  const staleNeighborSeed = { enabled: true };
  editor.activeTool = "orbit";
  editor.textureAirbrushActiveNeighborPaintSeed = staleNeighborSeed;
  editor.textureAirbrushCameraPrewarmScheduled = true;
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    resetFrames += 1;
    return true;
  };
  editor.prewarmTexturePaintActiveLayerMaterialGpu = () => {
    throw new Error("orbit camera changes should not prewarm layer material");
  };
  editor.prewarmTexturePaintActiveLayerProjectionGpu = () => {
    throw new Error("orbit camera changes should not prewarm layer projection");
  };
  editor.prewarmTexturePaintActiveLayerCursorProbe = () => {
    throw new Error("orbit camera changes should not prewarm cursor probe");
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(resetFrames, 1);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
  assert.equal(editor.textureAirbrushCameraPrewarmSerial, 1);
  assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);
  assert.deepEqual(prewarmCalls, []);
});

test("camera changes clear the active neighbor seed even if a stale paint stroke is down", () => {
  const editor = new TestEditor();
  const activeNeighborSeed = { enabled: true };
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.textureAirbrushActiveNeighborPaintSeed = activeNeighborSeed;
  editor.textureAirbrushResetLiveProjectionFrame = () => true;
  editor.scheduleTextureAirbrushSettledCameraPrewarm = () => true;

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
});

test("paint startup settles damped orbit motion with one projection reset", () => {
  const editor = new TestEditor();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
  const model = new THREE.Object3D();
  const calls = [];
  let updateCalls = 0;

  editor.camera = camera;
  editor.model = model;
  editor.controls = {
    update() {
      updateCalls += 1;
      calls.push(["controls-update", updateCalls]);
      editor.textureAirbrushCameraChanged();
      return updateCalls < 3;
    }
  };
  editor.textureAirbrushActiveNeighborPaintSeed = { enabled: true };
  editor.textureAirbrushCameraPrewarmScheduled = true;
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    calls.push(["reset-frame"]);
    return true;
  };

  assert.equal(editor.settleTextureAirbrushCameraMotion(), true);
  assert.deepEqual(calls, [
    ["controls-update", 1],
    ["controls-update", 2],
    ["controls-update", 3],
    ["reset-frame"]
  ]);
  assert.equal(editor.textureAirbrushActiveNeighborPaintSeed, null);
  assert.equal(editor.textureAirbrushCameraPrewarmSerial, 1);
  assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);
});

test("OrbitControls change events invalidate airbrush projection frames", () => {
  const source = fs.readFileSync(new URL("../src/weight-editor/scene-and-controls.js", import.meta.url), "utf8");
  assert.match(
    source,
    /this\.controls\.addEventListener\("change",\s*\(\)\s*=>\s*this\.textureAirbrushCameraChanged\?\.\(\)\)/
  );
});

test("layer camera prewarm warms the active layer before broad materials", (t) => {
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  globalThis.window = {
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
    requestIdleCallback() {
      throw new Error("broad layer prewarm should use the next frame before idle");
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  const editor = new TestEditor();
  const prewarmCalls = [];
  let cursorUpdates = 0;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.updateBrushCursorForLastPointer = () => {
    cursorUpdates += 1;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  assert.equal(editor.prewarmTextureAirbrushAfterCameraChange(), true);

  assert.equal(cursorUpdates, 1);
  assert.deepEqual(prewarmCalls, [[null, null, EXPECTED_LAYER_CAMERA_AIRBRUSH_PREWARM]]);
  assert.equal(frameCallbacks.length, 1);

  frameCallbacks.shift()();

  assert.deepEqual(prewarmCalls, [
    [null, null, EXPECTED_LAYER_CAMERA_AIRBRUSH_PREWARM],
    [null, null, EXPECTED_DEFERRED_LAYER_AIRBRUSH_PREWARM]
  ]);
});

test("deferred broad layer camera prewarm waits while a stroke is pending", (t) => {
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  globalThis.window = {
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  const editor = new TestEditor();
  const prewarmCalls = [];
  let pending = true;
  editor.activeTool = "airbrush";
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushScreenStrokeHasPendingWork = () => pending;
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  assert.equal(editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm(), true);
  assert.equal(frameCallbacks.length, 1);

  frameCallbacks.shift()();
  assert.deepEqual(prewarmCalls, []);
  assert.equal(frameCallbacks.length, 1);

  pending = false;
  frameCallbacks.shift()();

  assert.deepEqual(prewarmCalls, [[null, null, EXPECTED_DEFERRED_LAYER_AIRBRUSH_PREWARM]]);
});

test("camera layer prewarm waits until orbit damping settles", (t) => {
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  globalThis.window = {
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  const editor = new TestEditor();
  const prewarmCalls = [];
  let cursorUpdates = 0;
  let resetFrames = 0;
  editor.activeTool = "airbrush";
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    resetFrames += 1;
    return true;
  };
  editor.updateBrushCursorForLastPointer = () => {
    cursorUpdates += 1;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(resetFrames, 1);
  assert.equal(frameCallbacks.length, 1);
  assert.deepEqual(prewarmCalls, []);

  frameCallbacks.shift()();
  assert.equal(frameCallbacks.length, 1);
  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(resetFrames, 2);

  frameCallbacks.shift()();
  assert.deepEqual(prewarmCalls, []);
  assert.equal(frameCallbacks.length, 1);

  frameCallbacks.shift()();
  assert.equal(frameCallbacks.length, 1);
  frameCallbacks.shift()();

  assert.equal(cursorUpdates, 1);
  assert.deepEqual(prewarmCalls, [[null, null, EXPECTED_CAMERA_AIRBRUSH_PREWARM]]);
  assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);
});

test("layer camera change warms active layer material before settled projection prewarm", (t) => {
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  globalThis.window = {
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  const editor = new TestEditor();
  const activeMaterial = { name: "active-layer-material" };
  const calls = [];
  editor.activeTool = "airbrush";
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    calls.push("reset-frame");
    return true;
  };
  editor.prewarmTexturePaintActiveLayerMaterialGpu = (material) => {
    calls.push(["active-material-prewarm", material]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerProjectionGpu = (material) => {
    calls.push(["active-projection-prewarm", material]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerCursorProbe = (material) => {
    calls.push(["active-cursor-probe", material]);
    return true;
  };
  editor.updateBrushCursorForLastPointer = () => {
    calls.push("cursor");
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    calls.push(["camera-projection-prewarm", ...args]);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.deepEqual(calls, [
    "reset-frame",
    ["active-material-prewarm", activeMaterial],
    ["active-projection-prewarm", activeMaterial],
    ["active-cursor-probe", activeMaterial]
  ]);
  assert.equal(frameCallbacks.length, 1);

  frameCallbacks.shift()();
  frameCallbacks.shift()();

  assert.deepEqual(calls, [
    "reset-frame",
    ["active-material-prewarm", activeMaterial],
    ["active-projection-prewarm", activeMaterial],
    ["active-cursor-probe", activeMaterial],
    "cursor",
    ["camera-projection-prewarm", null, null, EXPECTED_LAYER_CAMERA_AIRBRUSH_PREWARM]
  ]);
});

test("stable render frame prewarms layer camera before timer fallback", (t) => {
  const originalWindow = globalThis.window;
  const frameCallbacks = [];
  globalThis.window = {
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }
  };
  t.after(() => {
    globalThis.window = originalWindow;
  });
  const editor = new TestEditor();
  const prewarmCalls = [];
  let cursorUpdates = 0;
  let resetFrames = 0;
  editor.activeTool = "airbrush";
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    resetFrames += 1;
    return true;
  };
  editor.updateBrushCursorForLastPointer = () => {
    cursorUpdates += 1;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  assert.equal(editor.textureAirbrushCameraChanged(), true);
  assert.equal(resetFrames, 1);
  assert.equal(frameCallbacks.length, 1);
  assert.equal(editor.textureAirbrushCameraPrewarmScheduled, true);

  assert.equal(editor.textureAirbrushPrewarmStableCameraFrame(), true);
  assert.equal(cursorUpdates, 1);
  assert.deepEqual(prewarmCalls, [[null, null, EXPECTED_CAMERA_AIRBRUSH_PREWARM]]);
  assert.equal(editor.textureAirbrushCameraPrewarmScheduled, false);

  frameCallbacks.shift()();
  assert.equal(frameCallbacks.length, 1);
  frameCallbacks.shift()();
  assert.equal(cursorUpdates, 1);
  assert.deepEqual(prewarmCalls, [[null, null, EXPECTED_CAMERA_AIRBRUSH_PREWARM]]);
});

test("selecting airbrush schedules active layer warm before broad prewarm", () => {
  const editor = new TestEditor();
  const activeMaterial = { uuid: "active-layer-material" };
  const prewarmCalls = [];
  let broadPrewarmCalls = 0;
  editor.activeTool = "paint";
  editor.texturePaintActiveMaterial = activeMaterial;
  editor.texturePaintLayerModeActive = () => true;
  editor.controls = {};
  editor.app = { classList: classListMock() };
  editor.canvas = { classList: classListMock() };
  editor.toolButtons = [];
  editor.usesSelectionStrokeUndo = () => false;
  editor.usesTextureStrokeUndo = () => false;
  editor.usesSelectionBrushCursor = () => false;
  editor.hasSelection = () => false;
  editor.hideTextureBrushCursor = () => {};
  editor.hideLassoOverlay = () => {};
  editor.preparePoseGizmoModeSwitch = () => {};
  editor.setBonePlacementPending = () => {};
  editor.pausePlayback = () => {};
  editor.setViewMode = () => {};
  editor.updateMoveGizmo = () => {};
  editor.updateBoneMoveGizmo = () => {};
  editor.updateIkMoveGizmo = () => {};
  editor.updateGizmoOnlyPreviewButton = () => {};
  editor.updateNeighborHover = () => {};
  editor.syncClonePaintControls = () => {};
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  editor.recordTutorialMacroToolChange = () => {};
  editor.scheduleTextureAirbrushDeferredBroadLayerPrewarm = () => {
    broadPrewarmCalls += 1;
    return true;
  };
  editor.prewarmTexturePaintActiveLayerMaterialGpu = (material) => {
    prewarmCalls.push(["active-material", material]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerProjectionGpu = (material) => {
    prewarmCalls.push(["active-projection", material]);
    return true;
  };
  editor.prewarmTexturePaintActiveLayerCursorProbe = (material) => {
    prewarmCalls.push(["active-cursor-probe", material]);
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(args);
    return true;
  };

  editor.setTool("airbrush");

  assert.equal(editor.activeTool, "airbrush");
  assert.equal(editor.lastStatus, "Airbrush texture color onto the model");
  assert.deepEqual(prewarmCalls, [
    ["active-material", activeMaterial],
    ["active-projection", activeMaterial],
    ["active-cursor-probe", activeMaterial],
    [null, null, {
      all: false,
      immediateLayer: false,
      delay: 0,
      force: true,
      limit: 1,
      liveDisplayExternalTexture: false,
      allowPrewarmLiveDisplayMaterialSwap: false,
      preserveLayerDisplay: true,
      prewarmPaintablesWithoutHit: true,
      warmScreenHitIndex: true,
      warmNeighborTopology: false,
      tslSurfacePrewarmAll: true,
      tslSurfacePrewarmLimit: 1,
      renderCompilePass: true
    }]
  ]);
  assert.equal(broadPrewarmCalls, 1);
});

test("returning from orbit to Neighbor airbrush schedules lightweight projection prewarm", () => {
  const editor = new TestEditor();
  const prewarmCalls = [];
  editor.activeTool = "orbit";
  editor.controls = {};
  editor.app = { classList: classListMock() };
  editor.canvas = { classList: classListMock() };
  editor.toolButtons = [];
  editor.usesSelectionStrokeUndo = () => false;
  editor.usesTextureStrokeUndo = () => false;
  editor.usesSelectionBrushCursor = () => false;
  editor.texturePaintNeighborModeEnabled = () => true;
  editor.texturePaintLayerModeActive = () => false;
  editor.hasSelection = () => false;
  editor.hideTextureBrushCursor = () => {};
  editor.hideLassoOverlay = () => {};
  editor.preparePoseGizmoModeSwitch = () => {};
  editor.setBonePlacementPending = () => {};
  editor.pausePlayback = () => {};
  editor.setViewMode = () => {};
  editor.updateMoveGizmo = () => {};
  editor.updateBoneMoveGizmo = () => {};
  editor.updateIkMoveGizmo = () => {};
  editor.updateGizmoOnlyPreviewButton = () => {};
  editor.updateNeighborHover = () => {};
  editor.syncClonePaintControls = () => {};
  editor.setStatus = () => {};
  editor.recordTutorialMacroToolChange = () => {};
  editor.textureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(["immediate", ...args]);
    return true;
  };
  editor.scheduleTextureAirbrushPrewarm = (...args) => {
    prewarmCalls.push(["scheduled", ...args]);
    return true;
  };

  editor.setTool("airbrush");

  assert.deepEqual(prewarmCalls, [
    ["immediate", null, null, {
      all: true,
      force: true,
      limit: 1,
      tslSurfacePrewarmAll: true,
      tslSurfacePrewarmLimit: 1,
      renderCompilePass: true
    }],
    ["immediate", null, null, {
      all: false,
      delay: 0,
      force: true,
      limit: 1,
      liveDisplayExternalTexture: false,
      allowPrewarmLiveDisplayMaterialSwap: false,
      prewarmPaintablesWithoutHit: true,
      warmScreenHitIndex: true,
      tslSurfacePrewarmAll: true,
      tslSurfacePrewarmLimit: 1,
      renderCompilePass: true
    }]
  ]);
});

test("switching from airbrush to orbit drains queued paint before changing active tool", () => {
  const editor = new TestEditor();
  const calls = [];
  editor.activeTool = "airbrush";
  editor.controls = {};
  editor.app = { classList: classListMock(["is-texture-airbrush"]) };
  editor.canvas = { classList: classListMock(["is-texture-airbrush"]) };
  editor.toolButtons = [];
  editor.usesSelectionStrokeUndo = () => false;
  editor.usesTextureStrokeUndo = (tool) => tool === "airbrush";
  editor.usesSelectionBrushCursor = () => false;
  editor.hasSelection = () => false;
  editor.hideTextureBrushCursor = () => {};
  editor.hideLassoOverlay = () => {};
  editor.preparePoseGizmoModeSwitch = () => {};
  editor.setBonePlacementPending = () => {};
  editor.updateMoveGizmo = () => {};
  editor.updateBoneMoveGizmo = () => {};
  editor.updateIkMoveGizmo = () => {};
  editor.updateGizmoOnlyPreviewButton = () => {};
  editor.updateNeighborHover = () => {};
  editor.syncClonePaintControls = () => {};
  editor.recordTutorialMacroToolChange = () => {};
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  editor.flushTextureAirbrushScreenStroke = () => {
    calls.push(["flush", editor.activeTool]);
    return 1;
  };
  editor.endTexturePaintStrokeUndo = () => {
    calls.push(["end-undo", editor.activeTool]);
    return true;
  };

  editor.setTool("orbit");

  assert.equal(editor.activeTool, "orbit");
  assert.deepEqual(calls, [
    ["flush", "airbrush"],
    ["end-undo", "airbrush"]
  ]);
  assert.equal(editor.lastStatus, "Orbit camera: left drag rotates, wheel zooms, right drag pans");
});

test("switching from an active airbrush stroke to orbit releases paint capture", () => {
  const editor = new TestEditor();
  const calls = [];
  const released = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 77;
  editor.controls = { enabled: false };
  editor.app = { classList: classListMock(["is-texture-airbrush"]) };
  editor.canvas = {
    classList: classListMock(["is-texture-airbrush"]),
    hasPointerCapture(pointerId) {
      return pointerId === 77;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };
  editor.toolButtons = [];
  editor.usesSelectionStrokeUndo = () => false;
  editor.usesTextureStrokeUndo = (tool) => tool === "airbrush";
  editor.usesSelectionBrushCursor = () => false;
  editor.hasSelection = () => false;
  editor.hideTextureBrushCursor = () => {};
  editor.hideLassoOverlay = () => {};
  editor.preparePoseGizmoModeSwitch = () => {};
  editor.setBonePlacementPending = () => {};
  editor.updateMoveGizmo = () => {};
  editor.updateBoneMoveGizmo = () => {};
  editor.updateIkMoveGizmo = () => {};
  editor.updateGizmoOnlyPreviewButton = () => {};
  editor.updateNeighborHover = () => {};
  editor.syncClonePaintControls = () => {};
  editor.recordTutorialMacroToolChange = () => {};
  editor.setStatus = (message) => {
    editor.lastStatus = message;
  };
  editor.flushTextureAirbrushScreenStroke = () => {
    calls.push(["flush", editor.activeTool]);
    return 1;
  };
  editor.endTexturePaintStrokeUndo = () => {
    calls.push(["end-undo", editor.activeTool]);
    editor.flushTextureAirbrushScreenStroke();
    return true;
  };

  editor.setTool("orbit");

  assert.equal(editor.activeTool, "orbit");
  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
  assert.deepEqual(released, [77]);
  assert.deepEqual(calls, [
    ["end-undo", "airbrush"],
    ["flush", "airbrush"]
  ]);
  assert.equal(editor.lastStatus, "Orbit camera: left drag rotates, wheel zooms, right drag pans");
});

test("pen orbit button zoom is isolated to the orbit tool", () => {
  const editor = new TestEditor();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
  const target = new THREE.Vector3(0, 0, 0);
  let capturedPointer = null;
  let releasedPointer = null;
  let controlsUpdated = 0;
  let rendered = 0;
  let stopped = 0;
  let prevented = 0;
  let cameraChanges = 0;
  camera.position.set(0, 0, 10);
  editor.camera = camera;
  editor.canvas = {
    setPointerCapture(pointerId) {
      capturedPointer = pointerId;
    },
    releasePointerCapture(pointerId) {
      releasedPointer = pointerId;
    }
  };
  editor.controls = {
    enabled: true,
    target,
    minDistance: 2,
    maxDistance: 20,
    zoomSpeed: 1,
    update() {
      controlsUpdated += 1;
    }
  };
  editor.render = () => {
    rendered += 1;
  };
  editor.textureAirbrushCameraChanged = () => {
    cameraChanges += 1;
  };
  const event = {
    pointerType: "pen",
    button: 2,
    buttons: 2,
    pointerId: 17,
    clientY: 100,
    preventDefault() {
      prevented += 1;
    },
    stopImmediatePropagation() {
      stopped += 1;
    },
    stopPropagation() {
      stopped += 1;
    }
  };

  editor.activeTool = "airbrush";
  assert.equal(editor.beginPenOrbitButtonZoom(event), false);
  assert.equal(capturedPointer, null);
  assert.equal(editor.controls.enabled, true);

  editor.activeTool = "orbit";
  assert.equal(editor.beginPenOrbitButtonZoom(event), true);
  assert.equal(capturedPointer, 17);
  assert.equal(editor.controls.enabled, false);
  assert.equal(prevented, 1);
  assert.equal(stopped, 2);

  assert.equal(editor.dragPenOrbitButtonZoom({
    pointerId: 17,
    clientY: 70,
    preventDefault() {},
    stopImmediatePropagation() {},
    stopPropagation() {}
  }), true);
  assert.equal(camera.position.distanceTo(target) < 10, true);
  assert.equal(controlsUpdated, 1);
  assert.equal(rendered, 1);
  assert.equal(cameraChanges, 1);

  assert.equal(editor.endPenOrbitButtonZoom({ pointerId: 17 }), true);
  assert.equal(releasedPointer, 17);
  assert.equal(editor.controls.enabled, true);
  assert.equal(cameraChanges, 2);
});

test("canvas pen zoom capture leaves primary airbrush strokes alone", () => {
  const editor = new TestEditor();
  let capturedPointer = null;
  let prevented = 0;
  let stopped = 0;
  const painted = [];
  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {
    setPointerCapture(pointerId) {
      capturedPointer = pointerId;
    }
  };
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = () => {};
  editor.paintTextureStrokeFromEvent = (event, options) => {
    painted.push({
      pointerType: event.pointerType,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      reset: options?.reset === true,
      strokeStart: options?.strokeStart || null
    });
    return true;
  };
  const event = {
    pointerType: "pen",
    button: 0,
    buttons: 1,
    pointerId: 42,
    clientX: 160,
    clientY: 140,
    preventDefault() {
      prevented += 1;
    },
    stopImmediatePropagation() {
      stopped += 1;
    },
    stopPropagation() {
      stopped += 1;
    }
  };

  assert.equal(editor.beginPenOrbitButtonZoom(event), false);
  assert.equal(prevented, 0);
  assert.equal(stopped, 0);

  editor.onPointerDown(event);
  assert.equal(prevented, 1);
  assert.equal(stopped, 0);
  assert.equal(editor.painting, true);
  assert.equal(editor.controls.enabled, false);
  assert.equal(capturedPointer, 42);
  assert.deepEqual(painted, []);
  assert.deepEqual(editor.textureAirbrushPendingInitialStroke?.point, {
    clientX: 160,
    clientY: 140
  });

  editor.onPointerMove({
    ...event,
    type: "pointermove",
    clientX: 170,
    clientY: 140,
    buttons: 1
  });

  assert.equal(prevented, 2);
  assert.deepEqual(painted, [{
    pointerType: "pen",
    button: 0,
    clientX: 170,
    clientY: 140,
    reset: true,
    strokeStart: { clientX: 160, clientY: 140 }
  }]);
});

test("airbrush pointerup without drag does not paint a delayed startup dot", () => {
  const editor = new TestEditor();
  let painted = 0;
  let undoEnded = 0;

  editor.activeTool = "airbrush";
  editor.controls = { enabled: true };
  editor.canvas = {
    setPointerCapture() {},
    releasePointerCapture() {}
  };
  editor.showTextureStrokeCursor = () => {};
  editor.beginTexturePaintStrokeUndo = () => {};
  editor.endTexturePaintStrokeUndo = () => {
    undoEnded += 1;
  };
  editor.paintTextureStrokeFromEvent = () => {
    painted += 1;
    return true;
  };
  editor.hideTextureBrushCursor = () => {};

  editor.onPointerDown({
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    pointerId: 9,
    clientX: 240,
    clientY: 180,
    preventDefault() {}
  });
  editor.onPointerUp({
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    pointerId: 9,
    clientX: 240,
    clientY: 180
  });

  assert.equal(painted, 0);
  assert.equal(undoEnded, 1);
  assert.equal(editor.painting, false);
  assert.equal(editor.textureAirbrushPendingInitialStroke, null);
});

test("idle airbrush restores orbit controls while primary paint disables them", () => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.controls = { enabled: false };

  assert.equal(editor.texturePaintIdleControlsEnabledForTool("airbrush"), true);
  assert.equal(editor.prepareTextureBrushPointerControls({
    button: 2,
    buttons: 2
  }), true);
  assert.equal(editor.controls.enabled, true);

  assert.equal(editor.prepareTextureBrushPointerControls({
    button: 0,
    buttons: 1
  }), true);
  assert.equal(editor.controls.enabled, false);
});

test("ending an airbrush stroke returns controls to idle orbit-ready state", () => {
  const editor = new TestEditor();
  const released = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 42;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 42;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };

  editor.onPointerUp({ pointerId: 42 });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
  assert.deepEqual(released, [42]);
});

test("non-primary texture brush gesture clears stale paint state before orbit", () => {
  const editor = new TestEditor();
  const released = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 52;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 52;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };
  editor.hideTextureBrushCursor = () => {};
  editor.flushSelectionStrokeFinalChange = () => {};
  editor.endSelectionStrokeUndo = () => {};
  editor.endTexturePaintStrokeUndo = () => {};

  const prepared = editor.prepareTextureBrushPointerControls({
    button: 2,
    buttons: 2,
    pointerId: 90,
    pointerType: "mouse",
    clientX: 120,
    clientY: 140
  });

  assert.equal(prepared, true);
  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
  assert.deepEqual(released, [52]);
});

test("ending an airbrush stroke clears stale OrbitControls pointer state", () => {
  const editor = new TestEditor();
  const canvasReleased = [];
  const orbitReleased = [];
  const removedListeners = [];
  const orbitPointerUps = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 42;
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 42;
    },
    releasePointerCapture(pointerId) {
      canvasReleased.push(pointerId);
    }
  };
  const ownerDocument = {
    removeEventListener(type, handler) {
      removedListeners.push([type, handler.name || "bound"]);
    }
  };
  editor.controls = {
    enabled: false,
    state: 0,
    _cursorStyle: "grab",
    _pointers: [42],
    _pointerPositions: {
      42: { x: 120, y: 140 }
    },
    _onPointerMove() {},
    _onPointerUp(event) {
      orbitPointerUps.push(event.pointerId);
      this._pointers.length = 0;
      delete this._pointerPositions[event.pointerId];
      this.state = -1;
    },
    domElement: {
      ownerDocument,
      style: { cursor: "grabbing" },
      hasPointerCapture(pointerId) {
        return pointerId === 42;
      },
      releasePointerCapture(pointerId) {
        orbitReleased.push(pointerId);
      }
    }
  };

  editor.onPointerUp({ pointerId: 42, clientX: 120, clientY: 140 });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.controls.state, -1);
  assert.deepEqual(editor.controls._pointers, []);
  assert.deepEqual(editor.controls._pointerPositions, {});
  assert.equal(editor.controls.domElement.style.cursor, "grab");
  assert.deepEqual(orbitPointerUps, [42]);
  assert.deepEqual(canvasReleased, [42]);
  assert.deepEqual(orbitReleased, [42]);
  assert.deepEqual(removedListeners.map(([type]) => type), ["pointermove", "pointerup"]);
});

test("ordinary orbit pointer release does not clear active OrbitControls state as paint cleanup", () => {
  const editor = new TestEditor();
  const orbitPointerUps = [];
  editor.activeTool = "orbit";
  editor.painting = false;
  editor.texturePaintActivePointerId = null;
  editor.canvas = {};
  editor.controls = {
    enabled: true,
    state: 0,
    _pointers: [9],
    _pointerPositions: {
      9: { x: 100, y: 120 }
    },
    _onPointerUp(event) {
      orbitPointerUps.push(event.pointerId);
      this._pointers.length = 0;
      this.state = -1;
    }
  };

  editor.onPointerUp({ pointerId: 9 });

  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.controls.state, 0);
  assert.deepEqual(editor.controls._pointers, [9]);
  assert.deepEqual(editor.controls._pointerPositions, {
    9: { x: 100, y: 120 }
  });
  assert.deepEqual(orbitPointerUps, []);
});

test("stale airbrush release does not cancel a new orbit pointer", () => {
  const editor = new TestEditor();
  const orbitPointerUps = [];
  const removedListeners = [];
  const released = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 42;
  editor.canvas = {
    hasPointerCapture() {
      return false;
    },
    releasePointerCapture(pointerId) {
      released.push(["canvas", pointerId]);
    }
  };
  const ownerDocument = {
    removeEventListener(type, handler) {
      removedListeners.push([type, handler.name || "bound"]);
    }
  };
  editor.controls = {
    enabled: false,
    state: 0,
    _pointers: [9],
    _pointerPositions: {
      9: { x: 160, y: 180 }
    },
    _onPointerMove() {},
    _onPointerUp(event) {
      orbitPointerUps.push(event.pointerId);
      this._pointers = this._pointers.filter((id) => id !== event.pointerId);
      delete this._pointerPositions[event.pointerId];
      if (!this._pointers.length) {
        this.state = -1;
      }
    },
    domElement: {
      ownerDocument,
      style: { cursor: "grabbing" },
      hasPointerCapture(pointerId) {
        return pointerId === 9;
      },
      releasePointerCapture(pointerId) {
        released.push(["orbit", pointerId]);
      }
    }
  };

  editor.onPointerUp({ pointerId: 42, clientX: 120, clientY: 140 });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.controls.state, 0);
  assert.deepEqual(editor.controls._pointers, [9]);
  assert.deepEqual(editor.controls._pointerPositions, {
    9: { x: 160, y: 180 }
  });
  assert.deepEqual(orbitPointerUps, []);
  assert.deepEqual(removedListeners, []);
  assert.deepEqual(released, []);
});

test("lost airbrush pointer release on move restores orbit controls", () => {
  const editor = new TestEditor();
  const released = [];
  let painted = 0;
  let prevented = 0;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 42;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 42;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };
  editor.paintTextureStrokeFromEvent = () => {
    painted += 1;
  };

  editor.onPointerMove({
    pointerId: 42,
    buttons: 0,
    preventDefault() {
      prevented += 1;
    }
  });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
  assert.equal(painted, 0);
  assert.equal(prevented, 0);
  assert.deepEqual(released, [42]);
});

test("transient pen buttons zero does not end an active airbrush stroke", () => {
  const editor = new TestEditor();
  const released = [];
  let painted = 0;
  let prevented = 0;
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 42;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 42;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };
  editor.showTextureStrokeCursor = () => {};
  editor.paintTextureStrokeFromEvent = () => {
    painted += 1;
    return true;
  };

  editor.onPointerMove({
    pointerId: 42,
    pointerType: "pen",
    buttons: 0,
    clientX: 120,
    clientY: 140,
    preventDefault() {
      prevented += 1;
    }
  });

  assert.equal(editor.painting, true);
  assert.equal(editor.controls.enabled, false);
  assert.equal(editor.texturePaintActivePointerId, 42);
  assert.equal(painted, 1);
  assert.equal(prevented, 1);
  assert.deepEqual(released, []);
});

test("already-ended airbrush pointer release still restores idle orbit controls", () => {
  const editor = new TestEditor();
  const released = [];
  editor.activeTool = "airbrush";
  editor.painting = false;
  editor.texturePaintActivePointerId = 17;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 17;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };

  editor.onPointerUp({ pointerId: 17 });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
  assert.deepEqual(released, [17]);
});

test("lost airbrush pointer capture restores orbit controls", () => {
  const editor = new TestEditor();
  const released = [];
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 31;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture(pointerId) {
      return pointerId === 31;
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };

  editor.onPointerUp({ type: "lostpointercapture", pointerId: 31 });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
  assert.deepEqual(released, [31]);
});

test("airbrush pointer release clears fallback paint input before orbit", () => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintMouseFallbackActive = true;
  editor.texturePaintMouseFallbackLastEvent = { type: "mousemove" };
  editor.texturePaintTouchFallbackActive = true;
  editor.texturePaintTouchFallbackIdentifier = 4;
  editor.controls = { enabled: false };
  editor.canvas = {};

  editor.onPointerUp({ pointerId: 4 });

  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintMouseFallbackActive, false);
  assert.equal(editor.texturePaintMouseFallbackLastEvent, null);
  assert.equal(editor.texturePaintTouchFallbackActive, false);
  assert.equal(editor.texturePaintTouchFallbackIdentifier, null);
});

test("canvas lostpointercapture is wired to end texture paint", () => {
  const source = fs.readFileSync(new URL("../src/weight-editor/scene-and-controls.js", import.meta.url), "utf8");
  assert.match(
    source,
    /this\.canvas\.addEventListener\("lostpointercapture",\s*\(event\)\s*=>\s*\{[\s\S]*?this\.onPointerUp\(event\);[\s\S]*?\}\);/
  );
});

test("airbrush pointer release restores orbit controls if final paint cleanup fails", () => {
  const editor = new TestEditor();
  editor.activeTool = "airbrush";
  editor.painting = true;
  editor.texturePaintActivePointerId = 19;
  editor.controls = { enabled: false };
  editor.canvas = {
    hasPointerCapture() {
      return false;
    },
    releasePointerCapture() {}
  };
  editor.flushSelectionStrokeFinalChange = () => {};
  editor.endSelectionStrokeUndo = () => {};
  editor.endTexturePaintStrokeUndo = () => {
    throw new Error("paint cleanup failed");
  };

  assert.throws(() => editor.onPointerUp({ pointerId: 19 }), /paint cleanup failed/);
  assert.equal(editor.painting, false);
  assert.equal(editor.controls.enabled, true);
  assert.equal(editor.texturePaintActivePointerId, null);
});

test("airbrush pointerdown settles orbit motion before reset stroke projection", () => {
  const editor = new TestEditor();
  const calls = [];
  let updateCalls = 0;

  editor.activeTool = "airbrush";
  editor.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
  editor.model = new THREE.Object3D();
  editor.controls = {
    enabled: true,
    update() {
      updateCalls += 1;
      calls.push(["controls-update", updateCalls]);
      editor.textureAirbrushCameraChanged();
      return updateCalls < 3;
    }
  };
  editor.canvas = {
    setPointerCapture() {
      calls.push(["capture"]);
    }
  };
  editor.textureAirbrushResetLiveProjectionFrame = () => {
    calls.push(["reset-frame"]);
    return true;
  };
  editor.prewarmTextureAirbrushAfterCameraChange = () => {
    calls.push(["prewarm-camera"]);
    return true;
  };
  editor.showTextureStrokeCursor = () => {
    calls.push(["cursor"]);
  };
  editor.usesSelectionStrokeUndo = () => false;
  editor.usesTextureStrokeUndo = () => true;
  editor.beginTexturePaintStrokeUndo = () => {
    calls.push(["begin-undo"]);
  };
  editor.paintTextureStrokeFromEvent = (event, options) => {
    calls.push(["paint", options?.reset === true, options?.strokeStart || null]);
    return true;
  };

  editor.onPointerDown({
    button: 0,
    pointerId: 4,
    clientX: 10,
    clientY: 12,
    preventDefault() {
      calls.push(["prevent"]);
    }
  });

  assert.deepEqual(calls, [
    ["prevent"],
    ["controls-update", 1],
    ["controls-update", 2],
    ["controls-update", 3],
    ["reset-frame"],
    ["prewarm-camera"],
    ["cursor"],
    ["begin-undo"],
    ["capture"]
  ]);

  editor.onPointerMove({
    button: 0,
    buttons: 1,
    pointerId: 4,
    clientX: 22,
    clientY: 12,
    preventDefault() {
      calls.push(["prevent-move"]);
    }
  });

  assert.deepEqual(calls, [
    ["prevent"],
    ["controls-update", 1],
    ["controls-update", 2],
    ["controls-update", 3],
    ["reset-frame"],
    ["prewarm-camera"],
    ["cursor"],
    ["begin-undo"],
    ["capture"],
    ["prevent-move"],
    ["cursor"],
    ["paint", true, { clientX: 10, clientY: 12 }]
  ]);
});
