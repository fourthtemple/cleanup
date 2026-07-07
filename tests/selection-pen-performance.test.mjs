import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { installPaintToolMethods } from "../src/weight-editor/paint-tools.js";
import { installSceneAndControlMethods } from "../src/weight-editor/scene-and-controls.js";

class TestEditor {}

installPaintToolMethods(TestEditor, { THREE });
installSceneAndControlMethods(TestEditor, { THREE });

test("selection pen strokes throttle heavy refresh work until stroke finalization", () => {
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frameCallbacks = [];
  globalThis.requestAnimationFrame = (callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const editor = new TestEditor();
    const calls = {
      colors: 0,
      counts: 0,
      markers: 0,
      moves: 0,
      patches: 0,
      statuses: []
    };
    editor.viewMode = "weight";
    editor.paintRecords = [{ selected: new Set() }];
    editor.updateRecordColors = () => {
      calls.colors += 1;
    };
    editor.updateCounts = () => {
      calls.counts += 1;
    };
    editor.updateSelectionMarkers = () => {
      calls.markers += 1;
    };
    editor.updateMoveGizmo = () => {
      calls.moves += 1;
    };
    editor.syncPatchJson = () => {
      calls.patches += 1;
    };
    editor.refreshClonePaintTargetFromSelection = () => 0;
    editor.setStatus = (message) => {
      calls.statuses.push(message);
    };

    editor.beginSelectionStrokeUndo("Paint stroke");
    assert.equal(editor.queueSelectionPaintChange(2, "paint"), true);
    assert.equal(editor.queueSelectionPaintChange(3, "paint"), true);
    assert.equal(frameCallbacks.length, 1);
    assert.deepEqual(calls, {
      colors: 0,
      counts: 0,
      markers: 0,
      moves: 0,
      patches: 0,
      statuses: []
    });

    frameCallbacks.shift()();
    assert.equal(calls.colors, 1);
    assert.equal(calls.markers, 1);
    assert.equal(calls.patches, 0);
    assert.equal(calls.counts, 0);
    assert.equal(calls.moves, 0);
    assert.deepEqual(calls.statuses, []);

    assert.equal(editor.flushSelectionStrokeFinalChange(), true);
    assert.equal(calls.patches, 1);
    assert.equal(calls.counts, 1);
    assert.equal(calls.moves, 1);
    assert.deepEqual(calls.statuses, ["Selected 5 vertices"]);
    assert.equal(editor.selectionStrokeUndo.changed, true);
  } finally {
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
  }
});

test("selection pen without Through only selects vertices near the raycasted surface depth", () => {
  const editor = new TestEditor();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    0, 0, -1
  ], 3));
  const object = new THREE.Object3D();
  object.updateMatrixWorld(true);
  const record = {
    geometry,
    object,
    selected: new Set(),
    deleted: new Set()
  };
  editor.canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100
    })
  };
  editor.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  editor.camera.position.set(0, 0, 5);
  editor.camera.lookAt(0, 0, 0);
  editor.camera.updateMatrixWorld(true);
  editor.camera.updateProjectionMatrix();
  editor.brushRadius = { value: "0.18" };
  editor.throughSelectionToggle = { checked: false };
  editor.tempVector = new THREE.Vector3();
  editor.tempWorld = new THREE.Vector3();
  editor.applyBoneTransform = () => {};
  editor.applyPaintActionWithMirror = (paintRecord, vertexIndex) => {
    const hadSelected = paintRecord.selected.has(vertexIndex);
    paintRecord.selected.add(vertexIndex);
    return hadSelected ? 0 : 1;
  };
  const changed = editor.paintVerticesNear(record, {
    point: new THREE.Vector3(0, 0, 0),
    face: { a: 0, b: 0, c: 0 }
  }, "paint", {
    event: {
      clientX: 50,
      clientY: 50
    }
  });
  assert.equal(changed, 1);
  assert.deepEqual([...record.selected], [0]);
});

test("neighbor selection prefers the raycasted surface seed over screen-nearest vertices", () => {
  const editor = new TestEditor();
  const surfaceSeed = { source: "surface" };
  const screenSeed = { source: "screen" };
  editor.brushRadius = { value: "0.035" };
  editor.nearestSurfaceVertex = () => surfaceSeed;
  editor.nearestScreenVertex = () => screenSeed;

  assert.equal(editor.nearestNeighborVertex({ clientX: 0, clientY: 0 }), surfaceSeed);
});

test("neighbor selection does not fall back to screen-nearest vertices unless explicitly requested", () => {
  const editor = new TestEditor();
  const screenSeed = { source: "screen" };
  let screenCalls = 0;
  editor.brushRadius = { value: "0.035" };
  editor.nearestSurfaceVertex = () => null;
  editor.nearestScreenVertex = () => {
    screenCalls += 1;
    return screenSeed;
  };

  assert.equal(editor.nearestNeighborVertex({ clientX: 0, clientY: 0 }), null);
  assert.equal(screenCalls, 0);
  assert.equal(
    editor.nearestNeighborVertex({ clientX: 0, clientY: 0 }, { allowScreenFallback: true }),
    screenSeed
  );
  assert.equal(screenCalls, 1);
});

test("selection vertex size is a global display setting for existing selection markers", () => {
  const editor = new TestEditor();
  editor.markerMaterial = new THREE.PointsMaterial({ size: 0.01, color: 0xffffff });
  editor.selectionMarkers = { renderOrder: 0, visible: false };
  editor.selectionVertexSize = { value: "14" };
  editor.selectionColorInput = { value: "#ff2cff" };
  editor.markerVertexCount = 12;
  editor.cleanPreview = false;
  editor.showSelectionLayer = true;
  editor.cloneSpotlightActive = false;
  editor.activeTool = "paint";

  editor.updateSelectionMarkerStyle();

  assert.equal(editor.markerMaterial.size, 14);
  assert.equal(editor.markerMaterial.sizeAttenuation, false);
  assert.equal(editor.markerMaterial.color.getHexString(), "ff2cff");
  assert.equal(editor.selectionMarkers.visible, true);
  assert.equal(editor.selectionMarkers.renderOrder, 180);

  editor.selectionVertexSize.value = "3.5";
  editor.updateSelectionMarkerStyle();

  assert.equal(editor.markerMaterial.size, 3.5);
  assert.equal(editor.markerMaterial.color.getHexString(), "ff2cff");
  assert.equal(editor.selectionMarkers.visible, true);
});

test("selection vertex size resizes existing instanced marker dots without moving them", () => {
  const editor = new TestEditor();
  editor.scene = new THREE.Scene();
  editor.selectionMarkerGeometry = new THREE.SphereGeometry(1, 4, 3);
  editor.markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  editor.selectionMarkerCapacity = 2;
  editor.selectionMarkers = new THREE.InstancedMesh(
    editor.selectionMarkerGeometry,
    editor.markerMaterial,
    editor.selectionMarkerCapacity
  );
  editor.selectionMarkers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  editor.selectionMarkerPositions = [0, 0, -10, 0, 1, -10];
  editor.markerVertexCount = 2;
  editor.selectionVertexSize = { value: "10" };
  editor.selectionColorInput = { value: "#00ff66" };
  editor.camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  editor.camera.position.set(0, 0, 0);
  editor.canvas = { clientHeight: 100 };
  editor.cleanPreview = false;
  editor.showSelectionLayer = true;
  editor.cloneSpotlightActive = false;
  editor.activeTool = "neighbor";
  editor.tempMatrix = new THREE.Matrix4();

  editor.updateSelectionMarkerStyle();

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  editor.selectionMarkers.getMatrixAt(0, matrix);
  matrix.decompose(position, rotation, scale);
  assert.deepEqual(position.toArray(), [0, 0, -10]);
  assert.equal(Number(scale.x.toFixed(3)), 1);
  assert.equal(Number(scale.y.toFixed(3)), 1);
  assert.equal(Number(scale.z.toFixed(3)), 1);

  editor.selectionVertexSize.value = "4";
  editor.updateSelectionMarkerStyle();

  editor.selectionMarkers.getMatrixAt(0, matrix);
  matrix.decompose(position, rotation, scale);
  assert.deepEqual(position.toArray(), [0, 0, -10]);
  assert.equal(Number(scale.x.toFixed(3)), 0.4);
  assert.equal(editor.selectionMarkers.count, 2);
  assert.equal(editor.selectionMarkers.visible, true);
});
