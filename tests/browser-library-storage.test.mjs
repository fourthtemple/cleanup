import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserAnimationLibraryStorage,
  browserLibraryActionIdFromFileName,
  browserLibraryDefaultFolderName
} from "../src/weight-editor/browser-library-storage.js";

function withObjectUrlMock(t) {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let nextId = 0;
  const revoked = [];
  URL.createObjectURL = () => `blob:test-${nextId += 1}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
  return revoked;
}

function memoryStorage() {
  const storage = new BrowserAnimationLibraryStorage();
  storage.useMemory = true;
  return storage;
}

test("browser library helpers normalize default names and action ids", () => {
  assert.equal(browserLibraryDefaultFolderName(), "browser-project");
  assert.equal(browserLibraryActionIdFromFileName("/Walk Cycles/Walking 8!.fbx?cache=1"), "walking-8");
  assert.equal(browserLibraryActionIdFromFileName("  idle.glb  "), "idle");
  assert.equal(browserLibraryActionIdFromFileName(""), "");
});

test("memory storage creates normalized folders and animation descriptors", async (t) => {
  withObjectUrlMock(t);
  const storage = memoryStorage();

  const folder = await storage.createFolder(" My Cat Folder! ");
  assert.deepEqual(folder.folder, {
    name: "my-cat-folder",
    label: "My Cat Folder!",
    path: "browser-library/my-cat-folder"
  });

  const upload = await storage.uploadFile({
    folder: " My Cat Folder! ",
    fileName: "Walking-8.FBX",
    blob: new Blob(["fbx"])
  });
  assert.equal(upload.folder, "my-cat-folder");
  assert.equal(upload.file.extension, "fbx");
  assert.equal(upload.file.cleanupFile, "Walking-8-weight-patch.json");
  assert.equal(upload.file.path, "browser-library/my-cat-folder/Walking-8.FBX");
  assert.equal(upload.file.url, "blob:test-1");

  const listed = await storage.list();
  assert.equal(listed.root, "browser-library");
  assert.equal(listed.folders.length, 1);
  assert.equal(listed.folders[0].name, "my-cat-folder");
  assert.equal(listed.folders[0].files[0].name, "Walking-8.FBX");
  assert.equal(listed.folders[0].files[0].url, "blob:test-2");
});

test("memory storage saves cleanup files and deletes entire folders", async (t) => {
  withObjectUrlMock(t);
  const storage = memoryStorage();
  await storage.uploadFile({
    folder: "cat",
    fileName: "walk.fbx",
    blob: new Blob(["fbx"])
  });
  await storage.saveCleanup({
    folder: "cat",
    fileName: "walk-weight-patch.json",
    content: { assignments: [] }
  });

  const beforeDelete = await storage.list();
  assert.match(beforeDelete.folders[0].files[0].cleanupUrl, /^blob:test-\d+$/);

  const deleted = await storage.deleteFolder({ folder: "cat" });
  assert.deepEqual(deleted, {
    ok: true,
    folder: "cat",
    filesDeleted: 1,
    cleanupsDeleted: 1
  });
  assert.deepEqual(await storage.list(), {
    root: "browser-library",
    folders: []
  });
});

test("saveCleanup rejects invalid JSON before writing a record", async () => {
  const storage = memoryStorage();
  await assert.rejects(
    storage.saveCleanup({
      folder: "cat",
      fileName: "broken.json",
      content: "{ nope"
    }),
    SyntaxError
  );
  assert.equal(storage.memoryCleanups.size, 0);
});
