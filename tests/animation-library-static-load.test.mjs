import assert from "node:assert/strict";
import test from "node:test";
import { installActorAndModelMethods } from "../src/weight-editor/actors-and-models.js";

class TestEditor {}
class SaveEditor {}

installActorAndModelMethods(TestEditor, {});

let savedCleanupRecord = null;
installActorAndModelMethods(SaveEditor, {
  writeAnimationLibraryCleanupFile: async (folder, fileName, text) => {
    savedCleanupRecord = { folder, fileName, text };
    return true;
  },
  writeJsonFile: async () => "download"
});

function withFetchGuard(t) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be used for browser library blobs");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function editorForStaticLibraryLoad() {
  const editor = new TestEditor();
  editor.loadToken = 0;
  editor.model = null;
  editor.actorTarget = null;
  editor.modelRoot = { visible: true };
  editor.statusMessages = [];
  editor.rememberAnimationLibraryFile = (item) => {
    editor.rememberedItem = item;
  };
  editor.animationLibraryActorTargetForFolder = (folder) => ({
    id: `library:${folder}`,
    animationLibraryFolder: folder
  });
  editor.setStatus = (message) => {
    editor.statusMessages.push(message);
  };
  editor.clearActorModel = () => {
    editor.clearedModel = true;
  };
  editor.attachEmbeddedFbxTextures = async () => {
    editor.attachedTextures = true;
  };
  editor.fbxLoader = {
    parse(buffer) {
      editor.parsedBytes = [...new Uint8Array(buffer)];
      return {
        name: "parsed-scene",
        animations: [{ name: "walk" }]
      };
    }
  };
  editor.loadImportedAnimationData = async (payload) => {
    editor.importedPayload = payload;
    return true;
  };
  editor.loadAnimationLibraryClipAsset = async () => {
    editor.clipAssetLoaded = true;
    return true;
  };
  editor.parseGLTFBuffer = async (buffer) => ({
    scene: { name: "parsed-gltf", bytes: [...new Uint8Array(buffer)] },
    animations: [{ name: "glb-walk" }]
  });
  return editor;
}

test("first browser-library FBX click opens the stored blob as the model", async (t) => {
  withFetchGuard(t);
  const editor = editorForStaticLibraryLoad();
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);

  const loaded = await editor.loadAnimationLibraryAsset({
    key: "browser-library/test/walking-8.fbx",
    folder: "test",
    name: "walking-8.fbx",
    extension: "fbx",
    url: "blob:blocked-by-csp",
    browserLibrary: true,
    blob
  });

  assert.equal(loaded, true);
  assert.equal(editor.clipAssetLoaded, undefined);
  assert.deepEqual(editor.parsedBytes, [1, 2, 3, 4]);
  assert.equal(editor.importedPayload.fileName, "walking-8.fbx");
  assert.equal(editor.importedPayload.sourceLabel, "test");
  assert.equal(editor.importedPayload.characterId, "library:test");
  assert.equal(editor.importedPayload.imported.animations.length, 1);
});

test("browser-library files become clip-only loads after their folder model is open", async () => {
  const editor = editorForStaticLibraryLoad();
  editor.model = {};
  editor.actorTarget = { id: "library:test" };
  let clipItem = null;
  editor.loadAnimationLibraryClipAsset = async (item) => {
    clipItem = item;
    return true;
  };
  editor.loadImportedAnimationData = async () => {
    throw new Error("open folder model should use clip asset path");
  };

  const loaded = await editor.loadAnimationLibraryAsset({
    key: "browser-library/test/walking-9.fbx",
    folder: "test",
    name: "walking-9.fbx",
    extension: "fbx",
    url: "blob:clip"
  });

  assert.equal(loaded, true);
  assert.equal(clipItem.name, "walking-9.fbx");
});

test("browser-library clip entries retain blobs without serializing them", () => {
  const editor = editorForStaticLibraryLoad();
  const blob = new Blob(["fbx"]);
  const cleanupBlob = new Blob([JSON.stringify({ assignments: [] })], { type: "application/json" });

  const entry = editor.animationLibraryClipEntryForItem({
    key: "browser-library/test/walk.fbx",
    folder: "test",
    name: "walk.fbx",
    url: "blob:clip",
    blob,
    cleanupBlob,
    cleanupUrl: "blob:cleanup"
  });

  assert.equal(entry.blob, blob);
  assert.equal(entry.libraryCleanupBlob, cleanupBlob);
  assert.equal(Object.keys(entry).includes("blob"), false);
  assert.equal(Object.keys(entry).includes("libraryCleanupBlob"), false);
});

test("browser-library cleanup JSON loads directly from its stored blob", async (t) => {
  withFetchGuard(t);
  const editor = editorForStaticLibraryLoad();
  editor.weightJson = { value: "" };
  const order = [];
  editor.applyPatchJson = ({ status }) => {
    order.push("apply");
    editor.patchAppliedWithStatus = status;
    editor.pendingSerializedTexturePaintsApply = Promise.resolve().then(() => {
      order.push("layers");
    });
  };
  editor.animationLibraryCleanupTargetForEntry = async () => ({
    folder: "test",
    fileName: "walk-weight-patch.json",
    blob: new Blob([JSON.stringify({ assignments: [{ bone: "Hips" }] })], { type: "application/json" })
  });

  const loaded = await editor.loadAnimationLibraryCleanupForEntry({}, { silent: true });

  assert.equal(loaded, true);
  assert.deepEqual(JSON.parse(editor.weightJson.value), { assignments: [{ bone: "Hips" }] });
  assert.equal(editor.patchAppliedWithStatus, false);
  assert.deepEqual(order, ["apply", "layers"]);
});

test("saving a cleanup waits for restored layers and flushes brush work before serializing", async () => {
  savedCleanupRecord = null;
  const editor = new SaveEditor();
  const order = [];
  const patch = { texturePaintLayers: [{ layers: [{ name: "Paint 1" }] }] };
  editor.animationLibraryCleanupSaveTarget = () => ({
    folder: "cat",
    fileName: "walk-weight-patch.json"
  });
  editor.pendingSerializedTexturePaintsApply = Promise.resolve().then(() => {
    order.push("restore");
  });
  editor.flushTexturePaintPendingBrushWorkBeforeLayerMutation = () => {
    order.push("brush");
  };
  editor.flushTexturePaintLayerGpuTargetsToCanvases = () => {
    order.push("gpu");
  };
  editor.syncPatchJson = () => {
    order.push("sync");
    return patch;
  };
  editor.serializePatchText = (value) => `${JSON.stringify(value, null, 2)}\n`;
  editor.refreshAnimationLibrary = async () => {};
  editor.setStatus = (message) => {
    editor.status = message;
  };

  assert.equal(await editor.savePatchFile(), true);
  assert.deepEqual(order, ["restore", "brush", "gpu", "sync"]);
  assert.equal(savedCleanupRecord.folder, "cat");
  assert.equal(savedCleanupRecord.fileName, "walk-weight-patch.json");
  assert.deepEqual(JSON.parse(savedCleanupRecord.text), patch);
});
