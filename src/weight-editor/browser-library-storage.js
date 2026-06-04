const DB_NAME = "telekinetikitty-cleanup-library";
const DB_VERSION = 2;
const FOLDER_STORE = "folders";
const FILE_STORE = "files";
const CLEANUP_STORE = "cleanups";

function sanitizeFolderName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

function animationExtension(fileName) {
  return String(fileName || "").split(".").pop()?.toLowerCase() || "";
}

function animationActionIdFromFileName(value) {
  return String(value || "")
    .split("?")[0]
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .toLowerCase() || "";
}

function cleanupFileName(fileName) {
  return `${String(fileName || "animation").replace(/\.[^.]+$/, "")}-weight-patch.json`;
}

function objectUrlForBlob(record) {
  if (record.objectUrl) {
    URL.revokeObjectURL(record.objectUrl);
  }
  record.objectUrl = URL.createObjectURL(record.blob);
  return record.objectUrl;
}

function descriptor(record) {
  const relativePath = `browser-library/${record.folder}/${record.name}`;
  const cleanupFile = cleanupFileName(record.name);
  return {
    key: relativePath,
    name: record.name,
    label: record.name,
    extension: animationExtension(record.name),
    folder: record.folder,
    path: relativePath,
    url: objectUrlForBlob(record),
    browserLibrary: true,
    cleanupFile,
    cleanupPath: `browser-library/${record.folder}/${cleanupFile}`,
    cleanupUrl: record.cleanupBlob ? URL.createObjectURL(record.cleanupBlob) : ""
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openDatabase() {
  if (!globalThis.indexedDB) {
    throw new Error("IndexedDB is not available");
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(FOLDER_STORE)) {
      db.createObjectStore(FOLDER_STORE, { keyPath: "name" });
    }
    if (!db.objectStoreNames.contains(FILE_STORE)) {
      db.createObjectStore(FILE_STORE, { keyPath: "key" });
    }
    if (!db.objectStoreNames.contains(CLEANUP_STORE)) {
      db.createObjectStore(CLEANUP_STORE, { keyPath: "key" });
    }
  };
  return requestToPromise(request);
}

export class BrowserAnimationLibraryStorage {
  constructor() {
    this.memoryFolders = new Map();
    this.memoryFiles = new Map();
    this.memoryCleanups = new Map();
    this.dbPromise = null;
    this.useMemory = false;
  }

  async db() {
    if (this.useMemory) {
      return null;
    }
    this.dbPromise ||= openDatabase().catch((error) => {
      console.warn("Using in-memory animation library storage", error);
      this.useMemory = true;
      return null;
    });
    return this.dbPromise;
  }

  fileKey(folder, fileName) {
    return `${sanitizeFolderName(folder)}/${fileName}`;
  }

  cleanupKey(folder, fileName) {
    return `${sanitizeFolderName(folder)}/${fileName}`;
  }

  async list() {
    const records = await this.fileRecords();
    const folderRecords = await this.folderRecords();
    const cleanups = await this.cleanupRecords();
    const cleanupByKey = new Map(cleanups.map((record) => [record.key, record]));
    const folders = new Map(folderRecords.map((record) => [record.name, {
      name: record.name,
      label: record.label || record.name,
      path: `browser-library/${record.name}`,
      files: []
    }]));
    for (const record of records) {
      const folder = folders.get(record.folder) || {
        name: record.folder,
        label: record.folder,
        path: `browser-library/${record.folder}`,
        files: []
      };
      const cleanup = cleanupByKey.get(this.cleanupKey(record.folder, cleanupFileName(record.name)));
      if (cleanup?.blob) {
        record.cleanupBlob = cleanup.blob;
      }
      folder.files.push(descriptor(record));
      folders.set(record.folder, folder);
    }
    return {
      root: "browser-library",
      folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((folder) => ({
        ...folder,
        files: folder.files.sort((a, b) => a.name.localeCompare(b.name))
      }))
    };
  }

  async fileRecords() {
    const db = await this.db();
    if (!db) {
      return [...this.memoryFiles.values()];
    }
    const transaction = db.transaction(FILE_STORE, "readonly");
    return requestToPromise(transaction.objectStore(FILE_STORE).getAll());
  }

  async folderRecords() {
    const db = await this.db();
    if (!db) {
      return [...this.memoryFolders.values()];
    }
    const transaction = db.transaction(FOLDER_STORE, "readonly");
    return requestToPromise(transaction.objectStore(FOLDER_STORE).getAll());
  }

  async cleanupRecords() {
    const db = await this.db();
    if (!db) {
      return [...this.memoryCleanups.values()];
    }
    const transaction = db.transaction(CLEANUP_STORE, "readonly");
    return requestToPromise(transaction.objectStore(CLEANUP_STORE).getAll());
  }

  async createFolder(folder) {
    const folderName = sanitizeFolderName(folder);
    if (!folderName) {
      throw new Error("Folder name is required");
    }
    const record = {
      name: folderName,
      label: folderName,
      createdAt: new Date().toISOString()
    };
    const db = await this.db();
    if (!db) {
      this.memoryFolders.set(folderName, record);
    } else {
      const transaction = db.transaction(FOLDER_STORE, "readwrite");
      transaction.objectStore(FOLDER_STORE).put(record);
      await transactionDone(transaction);
    }
    return {
      ok: true,
      folder: {
        name: folderName,
        path: `browser-library/${folderName}`
      }
    };
  }

  async uploadFile({ folder, fileName, blob }) {
    const folderName = sanitizeFolderName(folder);
    const name = String(fileName || "").trim();
    if (!folderName || !name || !blob) {
      throw new Error("Folder and animation file are required");
    }
    const record = {
      key: this.fileKey(folderName, name),
      folder: folderName,
      name,
      blob,
      bytes: blob.size || 0,
      createdAt: new Date().toISOString()
    };
    const db = await this.db();
    if (!db) {
      this.memoryFolders.set(folderName, { name: folderName, label: folderName });
      this.memoryFiles.set(record.key, record);
    } else {
      const transaction = db.transaction([FOLDER_STORE, FILE_STORE], "readwrite");
      transaction.objectStore(FOLDER_STORE).put({ name: folderName, label: folderName });
      transaction.objectStore(FILE_STORE).put(record);
      await transactionDone(transaction);
    }
    return {
      ok: true,
      folder: folderName,
      file: descriptor(record),
      bytes: record.bytes
    };
  }

  async deleteFile({ folder, fileName }) {
    const folderName = sanitizeFolderName(folder);
    const key = this.fileKey(folderName, fileName);
    const cleanupKey = this.cleanupKey(folderName, cleanupFileName(fileName));
    const db = await this.db();
    if (!db) {
      this.memoryFiles.delete(key);
      this.memoryCleanups.delete(cleanupKey);
    } else {
      const transaction = db.transaction([FILE_STORE, CLEANUP_STORE], "readwrite");
      transaction.objectStore(FILE_STORE).delete(key);
      transaction.objectStore(CLEANUP_STORE).delete(cleanupKey);
      await transactionDone(transaction);
    }
    return { ok: true, folder: folderName, fileName, cleanupDeleted: true };
  }

  async saveCleanup({ folder, fileName, content }) {
    const folderName = sanitizeFolderName(folder);
    const name = String(fileName || "").trim();
    if (!folderName || !name) {
      throw new Error("Folder and cleanup file name are required");
    }
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    JSON.parse(text);
    const record = {
      key: this.cleanupKey(folderName, name),
      folder: folderName,
      name,
      blob: new Blob([text], { type: "application/json" }),
      createdAt: new Date().toISOString()
    };
    const db = await this.db();
    if (!db) {
      this.memoryFolders.set(folderName, { name: folderName, label: folderName });
      this.memoryCleanups.set(record.key, record);
    } else {
      const transaction = db.transaction([FOLDER_STORE, CLEANUP_STORE], "readwrite");
      transaction.objectStore(FOLDER_STORE).put({ name: folderName, label: folderName });
      transaction.objectStore(CLEANUP_STORE).put(record);
      await transactionDone(transaction);
    }
    return { ok: true, folder: folderName, fileName: name, bytes: record.blob.size };
  }
}

export function browserLibraryDefaultFolderName() {
  return "browser-project";
}

export { animationActionIdFromFileName as browserLibraryActionIdFromFileName };
