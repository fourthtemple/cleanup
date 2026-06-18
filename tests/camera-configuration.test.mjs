import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../node_modules/three/build/three.module.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

class TestEditor {}

installSceneAndControlMethods(TestEditor, {
  THREE,
  finitePoseValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
});

function classListMock(initial = []) {
  const names = new Set(initial);
  return {
    names,
    add(name) {
      names.add(name);
    },
    remove(name) {
      names.delete(name);
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
  let prewarmScheduled = 0;
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
  editor.scheduleTextureAirbrushPrewarm = () => {
    prewarmScheduled += 1;
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
  assert.equal(prewarmScheduled, 1);
});
