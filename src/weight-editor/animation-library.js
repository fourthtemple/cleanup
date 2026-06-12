import {
  BrowserAnimationLibraryStorage,
  browserLibraryDefaultFolderName
} from "./browser-library-storage.js?v=folder-delete-20260607a";

function animationLibraryActionIdFromFileName(value) {
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

const BUILT_IN_DEMO_LIBRARY_FOLDER = Object.freeze({
  name: "cat",
  label: "Cat Demo",
  path: "assets/models/animation-library/cat",
  files: Object.freeze([
    Object.freeze({
      key: "built-in-demo:humanoid-cat-walking",
      name: "humanoid-cat-walking.fbx",
      label: "humanoid-cat-walking",
      extension: "fbx",
      folder: "cat",
      path: "assets/models/animation-library/cat/humanoid-cat-walking.fbx",
      url: "./assets/models/animation-library/cat/humanoid-cat-walking.fbx",
      cleanupFile: "humanoid-cat-walking-weight-patch.json",
      cleanupPath: "assets/models/animation-library/cat/humanoid-cat-walking-weight-patch.json",
      engine: true,
      demo: true
    })
  ])
});

function builtInDemoLibraryFolder({ includeFiles = true, folderName = BUILT_IN_DEMO_LIBRARY_FOLDER.name, label = BUILT_IN_DEMO_LIBRARY_FOLDER.label } = {}) {
  return {
    ...BUILT_IN_DEMO_LIBRARY_FOLDER,
    name: folderName,
    label,
    files: includeFiles
      ? BUILT_IN_DEMO_LIBRARY_FOLDER.files.map((file) => ({
        ...file,
        key: `built-in-demo:${folderName}:humanoid-cat-walking`,
        folder: folderName
      }))
      : []
  };
}

function normalizedDemoLibraryName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function installAnimationLibraryMethods(BirdWeightEditor) {
  const LAST_LIBRARY_FILE_KEY = "mixamo-cleanup-editor:last-library-file";

  Object.assign(BirdWeightEditor.prototype, {
    canUseAnimationLibraryServer() {
      const host = window.location.hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    },

    animationLibraryStartupMode() {
      const params = new URLSearchParams(window.location.search || "");
      const requested = String(params.get("library") || params.get("storage") || "").toLowerCase();
      if (requested === "browser") {
        return "browser";
      }
      if (["server", "auto"].includes(requested) && this.canUseAnimationLibraryServer()) {
        return requested;
      }
      return "browser";
    },

    ensureBrowserAnimationLibraryStorage() {
      if (!this.browserAnimationLibraryStorage) {
        this.browserAnimationLibraryStorage = new BrowserAnimationLibraryStorage();
      }
      window.telekinetikittyAnimationLibraryStorage = this.browserAnimationLibraryStorage;
      return this.browserAnimationLibraryStorage;
    },

    async browserAnimationLibraryPayload() {
      const storage = this.ensureBrowserAnimationLibraryStorage();
      const payload = await storage.list();
      if (!payload.folders.length) {
        const folder = browserLibraryDefaultFolderName();
        await storage.createFolder(folder);
        payload.folders.push({
          name: folder,
          label: folder,
          path: `browser-library/${folder}`,
          files: []
        });
      }
      this.animationLibraryStorageMode = "browser";
      return payload;
    },

    async serverAnimationLibraryPayload() {
      const response = await fetch("/api/animation-library", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.animationLibraryStorageMode = "server";
      return response.json();
    },

    animationLibraryPayloadWithBuiltInDemos(payload = {}) {
      let folders = Array.isArray(payload.folders)
        ? payload.folders.map((folder) => ({
          ...folder,
          files: Array.isArray(folder.files) ? [...folder.files] : []
        }))
        : [];
      const demoName = this.tutorialDemoAnimationLibraryName();
      if (!demoName || !this.tutorialDemoLibraryImported || !this.tutorialDemoLibraryFolderName) {
        return {
          ...payload,
          folders
        };
      }
      const existing = folders.find((folder) => folder.name === this.tutorialDemoLibraryFolderName);
      if (existing) {
        const demoFolder = builtInDemoLibraryFolder({
          folderName: existing.name,
          label: existing.label || existing.name
        });
        existing.label ||= demoFolder.label;
        existing.path ||= demoFolder.path;
        const keys = new Set(existing.files.map((file) => file.key || file.path || file.name));
        existing.files.unshift(
          ...demoFolder.files.filter((file) => !keys.has(file.key || file.path || file.name))
        );
      }
      return {
        ...payload,
        folders
      };
    },

    setAnimationLibraryFoldersFromPayload(payload = {}) {
      const payloadWithDemos = this.animationLibraryPayloadWithBuiltInDemos(payload);
      this.animationLibraryFolders = Array.isArray(payloadWithDemos.folders) ? payloadWithDemos.folders : [];
      const current = this.animationLibrarySelectedFolder || this.animationLibraryFolderSelect?.value || "";
      const hasCurrent = this.animationLibraryFolders.some((folder) => folder.name === current);
      this.animationLibrarySelectedFolder = hasCurrent
        ? current
        : this.animationLibraryFolders[0]?.name || "";
    },

    bindAnimationLibraryControls() {
      if (this.animationLibraryControlsBound) {
        return;
      }
      this.animationLibraryControlsBound = true;

      this.animationLibraryRefreshButton?.addEventListener("click", () => {
        void this.refreshAnimationLibrary();
      });
      this.createAnimationLibraryFolderButton?.addEventListener("click", () => {
        void this.createAnimationLibraryFolder();
      });
      this.animationLibraryFolderName?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.createAnimationLibraryFolder();
        }
      });
      this.animationLibraryFolderSelect?.addEventListener("change", () => {
        this.animationLibrarySelectedFolder = this.animationLibraryFolderSelect.value;
        this.hideDeleteAnimationLibraryFolderConfirm?.();
        this.renderAnimationLibrary();
      });
      this.deleteAnimationLibraryFolderButton?.addEventListener("click", () => {
        this.showDeleteAnimationLibraryFolderConfirm();
      });
      this.confirmDeleteAnimationLibraryFolderButton?.addEventListener("click", () => {
        void this.deleteSelectedAnimationLibraryFolder({ confirmed: true });
      });
      this.cancelDeleteAnimationLibraryFolderButton?.addEventListener("click", () => {
        this.hideDeleteAnimationLibraryFolderConfirm({ status: true });
      });
      this.animationLibraryImportButton?.addEventListener("click", () => {
        if (!this.selectedAnimationLibraryFolderName()) {
          this.setStatus("Create an animation folder first");
          return;
        }
        if (this.animationLibraryFileInput) {
          this.animationLibraryFileInput.value = "";
          this.animationLibraryFileInput.click();
        }
      });
      this.animationLibraryFileInput?.addEventListener("change", () => {
        const files = Array.from(this.animationLibraryFileInput.files || []);
        if (files.length) {
          void this.importAnimationFilesToLibrary(files);
        }
      });
      this.animationLibrarySaveAsButton?.addEventListener("click", () => {
        this.showAnimationLibrarySaveAsControls();
      });
      this.animationLibrarySaveAsOkButton?.addEventListener("click", () => {
        void this.confirmAnimationLibrarySaveAs();
      });
      this.animationLibrarySaveAsCancelButton?.addEventListener("click", () => {
        this.hideAnimationLibrarySaveAsControls();
      });
      this.animationLibrarySaveAsNameInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.confirmAnimationLibrarySaveAs();
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.hideAnimationLibrarySaveAsControls();
        }
      });
      this.animationLibraryList?.addEventListener("click", (event) => {
        const deleteButton = event.target.closest?.("[data-animation-library-delete-key]");
        if (deleteButton) {
          event.preventDefault();
          event.stopPropagation();
          const item = this.findAnimationLibraryFile(deleteButton.dataset.animationLibraryDeleteKey);
          if (item) {
            void this.deleteAnimationLibraryFile(item);
          }
          return;
        }
        const button = event.target.closest?.("[data-animation-library-key]");
        if (!button) {
          return;
        }
        const item = this.findAnimationLibraryFile(button.dataset.animationLibraryKey);
        if (item) {
          void this.loadAnimationLibraryAsset(item);
        }
      });
    },

    selectedAnimationLibraryFolderName() {
      return this.animationLibraryFolderSelect?.value || this.animationLibrarySelectedFolder || "";
    },

    selectedLibraryCharacterFolderName() {
      const selectedCharacterId = this.characterSelect?.value || this.actorTarget?.id || "";
      if (String(selectedCharacterId).startsWith("library:")) {
        return String(selectedCharacterId).slice("library:".length);
      }
      return "";
    },

    async refreshAnimationLibrary({ silent = false } = {}) {
      const startupMode = this.animationLibraryStartupMode();
      try {
        const payload = startupMode === "browser"
          ? await this.browserAnimationLibraryPayload()
          : await this.serverAnimationLibraryPayload();
        this.setAnimationLibraryFoldersFromPayload(payload);
        this.renderAnimationLibrary();
        this.renderCharacterOptions?.();
        if (!silent) {
          this.setStatus("Animation library refreshed");
        }
        return true;
      } catch (error) {
        if (startupMode === "auto") {
          try {
            const payload = await this.browserAnimationLibraryPayload();
            this.setAnimationLibraryFoldersFromPayload(payload);
            this.renderAnimationLibrary();
            this.renderCharacterOptions?.();
            if (!silent) {
              this.setStatus("Using browser project storage");
            }
            return true;
          } catch (browserError) {
            console.warn("Could not open browser animation library", browserError);
          }
        }
        console.warn("Could not refresh animation library", error);
        this.animationLibraryFolders = [];
        this.animationLibrarySelectedFolder = "";
        this.renderAnimationLibrary();
        this.renderCharacterOptions?.();
        if (!silent) {
          this.setStatus("Could not refresh animation library");
        }
        return false;
      }
    },

    renderAnimationLibrary() {
      if (this.animationLibraryFolderSelect) {
        if (this.animationLibraryFolders.length) {
          const options = this.animationLibraryFolders.map((folder) => {
            const option = document.createElement("option");
            option.value = folder.name;
            option.textContent = folder.label || folder.name;
            return option;
          });
          this.animationLibraryFolderSelect.replaceChildren(...options);
          this.animationLibraryFolderSelect.disabled = false;
          this.animationLibraryFolderSelect.value = this.animationLibrarySelectedFolder || this.animationLibraryFolders[0].name;
          this.animationLibrarySelectedFolder = this.animationLibraryFolderSelect.value;
        } else {
          const option = document.createElement("option");
          option.value = "";
          option.textContent = "No folders";
          this.animationLibraryFolderSelect.replaceChildren(option);
          this.animationLibraryFolderSelect.disabled = true;
          this.animationLibrarySelectedFolder = "";
        }
      }

      if (this.animationLibraryImportButton) {
        this.animationLibraryImportButton.disabled = !this.selectedAnimationLibraryFolderName();
      }
      if (this.deleteAnimationLibraryFolderButton) {
        this.deleteAnimationLibraryFolderButton.disabled = !this.selectedAnimationLibraryFolderName();
      }
      if (!this.selectedAnimationLibraryFolderName()) {
        this.hideDeleteAnimationLibraryFolderConfirm?.();
      }
      if (!this.animationLibraryList) {
        return;
      }

      const folderName = this.selectedAnimationLibraryFolderName();
      const folder = this.animationLibraryFolders.find((item) => item.name === folderName);
      if (!folder) {
        this.animationLibraryList.replaceChildren(this.animationLibraryEmptyNode("No animation folders"));
        return;
      }
      const files = Array.isArray(folder.files) ? folder.files : [];
      if (!files.length) {
        this.animationLibraryList.replaceChildren(this.animationLibraryEmptyNode("Empty folder"));
        return;
      }

      this.animationLibraryList.replaceChildren(
        ...files.map((file) => {
          const row = document.createElement("div");
          row.className = "animation-library-file-row";
          row.classList.toggle("is-engine-asset", Boolean(file.engine));
          row.classList.toggle("is-unavailable", file.available === false);

          const button = document.createElement("button");
          button.type = "button";
          button.className = "animation-library-file";
          button.dataset.animationLibraryKey = file.key || file.path;
          button.disabled = file.available === false;

          const name = document.createElement("span");
          name.className = "animation-library-file-name";
          name.textContent = file.label || file.name;

          const meta = document.createElement("span");
          meta.className = "animation-library-file-meta";
          meta.textContent = file.procedural ? "PROC" : file.extension?.toUpperCase() || "ANIM";

          button.append(name, meta);
          row.append(button);

          if (!file.engine) {
            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "animation-library-file-delete";
            deleteButton.dataset.animationLibraryDeleteKey = file.key || file.path;
            deleteButton.textContent = "x";
            deleteButton.title = `Delete ${file.name}`;
            deleteButton.setAttribute("aria-label", `Delete ${file.name}`);
            row.append(deleteButton);
          }

          return row;
        })
      );
    },

    animationLibraryEmptyNode(message) {
      const node = document.createElement("p");
      node.className = "animation-library-empty";
      node.textContent = message;
      return node;
    },

    async createAnimationLibraryFolder(folderName = this.animationLibraryFolderName?.value) {
      const requestedName = String(folderName || "").trim();
      if (!requestedName) {
        this.setStatus("Name the animation folder first");
        this.animationLibraryFolderName?.focus();
        return false;
      }

      try {
        if (this.animationLibraryStorageMode === "browser") {
          const payload = await this.ensureBrowserAnimationLibraryStorage().createFolder(requestedName);
          this.animationLibrarySelectedFolder = payload.folder?.name || requestedName;
          this.rememberTutorialDemoAnimationLibraryFolder?.(this.animationLibrarySelectedFolder);
          if (this.animationLibraryFolderName) {
            this.animationLibraryFolderName.value = "";
          }
          await this.refreshAnimationLibrary({ silent: true });
          this.setStatus(`Created browser folder ${this.animationLibrarySelectedFolder}`);
          return true;
        }
        const response = await fetch("/api/animation-library/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder: requestedName })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        this.animationLibrarySelectedFolder = payload.folder?.name || requestedName;
        this.rememberTutorialDemoAnimationLibraryFolder?.(this.animationLibrarySelectedFolder);
        if (this.animationLibraryFolderName) {
          this.animationLibraryFolderName.value = "";
        }
        await this.refreshAnimationLibrary({ silent: true });
        this.setStatus(`Created animation folder ${this.animationLibrarySelectedFolder}`);
        return true;
      } catch (error) {
        console.error(error);
        this.setStatus("Could not create animation folder");
        return false;
      }
    },

    animationLibraryFolderDeleteDetails(folder) {
      const fileCount = Array.isArray(folder?.files) ? folder.files.filter((file) => !file.engine).length : 0;
      const label = folder?.label || folder?.name || "folder";
      const detail = fileCount
        ? ` and ${fileCount} ${fileCount === 1 ? "animation/cleanup" : "animations/cleanups"}`
        : "";
      return { fileCount, label, detail };
    },

    showDeleteAnimationLibraryFolderConfirm() {
      const folderName = this.selectedAnimationLibraryFolderName();
      const folder = this.animationLibraryFolders.find((item) => item.name === folderName);
      if (!folderName || !folder) {
        this.setStatus("Choose an animation folder first");
        return false;
      }
      const { label, detail } = this.animationLibraryFolderDeleteDetails(folder);
      this.pendingAnimationLibraryFolderDelete = { folderName, label };
      if (!this.deleteAnimationLibraryFolderConfirm) {
        return this.deleteSelectedAnimationLibraryFolder({ confirmed: true });
      }
      if (this.deleteAnimationLibraryFolderConfirmMessage) {
        this.deleteAnimationLibraryFolderConfirmMessage.textContent = `Delete ${label}${detail}?`;
      }
      this.deleteAnimationLibraryFolderConfirm.hidden = false;
      this.deleteAnimationLibraryFolderButton?.setAttribute("aria-expanded", "true");
      this.confirmDeleteAnimationLibraryFolderButton?.focus?.({ preventScroll: true });
      this.setStatus(`Confirm delete folder ${label}`);
      return true;
    },

    hideDeleteAnimationLibraryFolderConfirm({ status = false } = {}) {
      this.pendingAnimationLibraryFolderDelete = null;
      if (this.deleteAnimationLibraryFolderConfirm) {
        this.deleteAnimationLibraryFolderConfirm.hidden = true;
      }
      this.deleteAnimationLibraryFolderButton?.setAttribute("aria-expanded", "false");
      if (status) {
        this.setStatus("Folder delete canceled");
      }
      return true;
    },

    async deleteSelectedAnimationLibraryFolder({ confirmed = false } = {}) {
      const folderName = this.selectedAnimationLibraryFolderName();
      const folder = this.animationLibraryFolders.find((item) => item.name === folderName);
      if (!folderName || !folder) {
        this.setStatus("Choose an animation folder first");
        return false;
      }
      if (!confirmed) {
        return this.showDeleteAnimationLibraryFolderConfirm();
      }
      const { label } = this.animationLibraryFolderDeleteDetails(folder);
      const pendingFolder = this.pendingAnimationLibraryFolderDelete?.folderName || "";
      if (pendingFolder && pendingFolder !== folderName) {
        this.hideDeleteAnimationLibraryFolderConfirm();
        this.setStatus("Choose the folder again before deleting");
        return false;
      }
      try {
        if (this.deleteAnimationLibraryFolderButton) {
          this.deleteAnimationLibraryFolderButton.disabled = true;
        }
        if (this.animationLibraryStorageMode === "browser") {
          await this.ensureBrowserAnimationLibraryStorage().deleteFolder({ folder: folderName });
        } else {
          const response = await fetch("/api/animation-library/folder/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder: folderName })
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || `HTTP ${response.status}`);
          }
        }
        if (this.animationLibrarySelectedFolder === folderName) {
          this.animationLibrarySelectedFolder = "";
        }
        if (this.tutorialDemoLibraryFolderName === folderName) {
          this.tutorialDemoLibraryFolderName = "";
          this.tutorialDemoLibraryImported = false;
        }
        this.hideDeleteAnimationLibraryFolderConfirm();
        await this.refreshAnimationLibrary({ silent: true });
        this.setStatus(`Deleted folder ${label}`);
        return true;
      } catch (error) {
        console.error(error);
        this.setStatus(`Could not delete folder ${label}`);
        return false;
      } finally {
        if (this.deleteAnimationLibraryFolderButton) {
          this.deleteAnimationLibraryFolderButton.disabled = !this.selectedAnimationLibraryFolderName();
        }
      }
    },

    async importAnimationFilesToLibrary(files) {
      const folderName = this.selectedAnimationLibraryFolderName();
      if (!folderName) {
        this.setStatus("Create an animation folder first");
        return false;
      }

      const importFiles = Array.from(files || []);
      if (!importFiles.length) {
        return false;
      }

      if (this.animationLibraryImportButton) {
        this.animationLibraryImportButton.disabled = true;
      }
      this.setStatus(`Importing ${importFiles.length} ${importFiles.length === 1 ? "animation" : "animations"} to ${folderName}`);

      const uploaded = [];
      for (const file of importFiles) {
        const upload = await this.uploadAnimationLibraryFile(file, folderName);
        if (!upload) {
          if (this.animationLibraryImportButton) {
            this.animationLibraryImportButton.disabled = false;
          }
          return false;
        }
        uploaded.push(upload);
      }

      await this.refreshAnimationLibrary({ silent: true });
      const lastUploaded = uploaded[uploaded.length - 1];
      if (lastUploaded?.file) {
        await this.loadAnimationLibraryAsset(lastUploaded.file);
      }
      if (this.animationLibraryImportButton) {
        this.animationLibraryImportButton.disabled = !this.selectedAnimationLibraryFolderName();
      }
      const count = uploaded.length;
      this.setStatus(`Imported ${count} ${count === 1 ? "animation" : "animations"} to ${folderName}`);
      return true;
    },

    async deleteAnimationLibraryFile(item) {
      if (!item || item.engine) {
        this.setStatus("Engine animations cannot be deleted here");
        return false;
      }
      const fileName = item.name || String(item.path || "").split("/").pop() || "";
      const folderName = item.folder || this.selectedAnimationLibraryFolderName();
      if (!folderName || !fileName) {
        this.setStatus("Choose an imported animation to delete");
        return false;
      }
      if (!window.confirm(`Delete ${fileName} from ${folderName}?`)) {
        return false;
      }
      try {
        if (this.animationLibraryStorageMode === "browser" || item.browserLibrary) {
          await this.ensureBrowserAnimationLibraryStorage().deleteFile({ folder: folderName, fileName });
          await this.refreshAnimationLibrary({ silent: true });
          this.setStatus(`Deleted ${fileName} from ${folderName}`);
          return true;
        }
        const response = await fetch("/api/animation-library/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder: folderName,
            fileName
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        await this.refreshAnimationLibrary({ silent: true });
        this.setStatus(`Deleted ${fileName} from ${folderName}`);
        return true;
      } catch (error) {
        console.error(error);
        this.setStatus(`Could not delete ${fileName}`);
        return false;
      }
    },

    async uploadAnimationLibraryFile(file, folderName) {
      try {
        if (this.animationLibraryStorageMode === "browser") {
          return await this.uploadAnimationLibraryBlob({
            folderName,
            fileName: file.name,
            blob: file
          });
        }
        const contentBase64 = await this.animationFileToBase64(file);
        const response = await fetch("/api/animation-library/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder: folderName,
            fileName: file.name,
            contentBase64
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        return payload;
      } catch (error) {
        console.error(error);
        this.setStatus(`Could not import ${file.name}`);
        return null;
      } finally {
        if (this.animationLibraryImportButton) {
          this.animationLibraryImportButton.disabled = !this.selectedAnimationLibraryFolderName();
        }
      }
    },

    async uploadAnimationLibraryBlob({ folderName, fileName, blob }) {
      return this.ensureBrowserAnimationLibraryStorage().uploadFile({
        folder: folderName,
        fileName,
        blob
      });
    },

    async animationFileToBase64(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      return btoa(binary);
    },

    findAnimationLibraryFile(key) {
      for (const folder of this.animationLibraryFolders) {
        const file = (folder.files || []).find((item) => (item.key || item.path) === key);
        if (file) {
          return file;
        }
      }
      return null;
    },

    selectedAnimationLibraryFile() {
      const folderName = this.selectedLibraryCharacterFolderName()
        || this.selectedAnimationLibraryFolderName()
        || this.actorTarget?.libraryFolder
        || this.actorTarget?.animationLibraryFolder
        || "";
      const folder = this.animationLibraryFolders.find((item) => item.name === folderName);
      const files = (folder?.files || []).filter((file) => file.available !== false);
      if (!files.length) {
        return null;
      }
      const selectedActionId = this.actionSelect?.value || "";
      const activeKey = this.activeClipEntry?.libraryKey || this.activeClipEntry?.libraryPath || "";
      const activeActionId = this.activeClipEntry?.id || "";
      return files.find((file) => animationLibraryActionIdFromFileName(file.name || file.path) === selectedActionId)
        || files.find((file) => (file.key || file.path) === activeKey)
        || files.find((file) => animationLibraryActionIdFromFileName(file.name || file.path) === activeActionId)
        || files[0];
    },

    async loadSelectedAnimationLibraryFile() {
      const item = this.selectedAnimationLibraryFile();
      if (!item) {
        this.setStatus("Choose an animation folder and import an FBX or GLB at the bottom first");
        return false;
      }
      const loaded = await this.loadAnimationLibraryAsset(item);
      if (!loaded) {
        return false;
      }
      const folderName = item.folder || this.selectedLibraryCharacterFolderName() || this.selectedAnimationLibraryFolderName();
      const label = animationLibraryActionIdFromFileName(item.name || item.path) || item.name || "animation";
      this.setStatus(`Loaded ${folderName ? `${folderName} / ` : ""}${label}`);
      return true;
    },

    rememberAnimationLibraryFile(item) {
      const key = item?.key || item?.path || "";
      if (!key) {
        return;
      }
      try {
        window.localStorage?.setItem(LAST_LIBRARY_FILE_KEY, key);
      } catch {
        // localStorage can be unavailable in private contexts.
      }
    },

    lastAnimationLibraryFile() {
      let storedKey = "";
      try {
        storedKey = window.localStorage?.getItem(LAST_LIBRARY_FILE_KEY) || "";
      } catch {
        storedKey = "";
      }
      return storedKey ? this.findAnimationLibraryFile(storedKey) : null;
    },

    storedAnimationLibraryFile() {
      let storedKey = "";
      try {
        storedKey = window.localStorage?.getItem(LAST_LIBRARY_FILE_KEY) || "";
      } catch {
        storedKey = "";
      }
      return storedKey ? this.findAnimationLibraryFile(storedKey) : null;
    },

    firstAvailableAnimationLibraryFile() {
      for (const folder of this.animationLibraryFolders || []) {
        const file = (folder.files || []).find((item) => item.available !== false);
        if (file) {
          return file.folder ? file : { ...file, folder: folder.name };
        }
      }
      return null;
    },

    tutorialDemoAnimationLibraryQueryName() {
      const params = new URLSearchParams(window.location.search || "");
      const requested = params.get("tutorial-demo")
        ?? params.get("tutorialDemo")
        ?? params.get("demo-character")
        ?? params.get("demo");
      if (requested === null) {
        return null;
      }
      const normalized = normalizedDemoLibraryName(requested);
      if (!normalized || ["1", "true", "yes", "on"].includes(normalized)) {
        return "cat";
      }
      if (["0", "false", "no", "off", "none"].includes(normalized)) {
        return "";
      }
      return normalized;
    },

    tutorialDemoAnimationLibraryName() {
      const requested = this.tutorialDemoAnimationLibraryQueryName?.();
      if (requested === "") {
        return "";
      }
      if (this.tutorialSessionActive || this.tutorialDrawerOpen) {
        return requested || "cat";
      }
      return "";
    },

    demoAnimationLibraryFile(demoName = "cat") {
      const normalized = normalizedDemoLibraryName(demoName) || "cat";
      const candidates = [];
      for (const folder of this.animationLibraryFolders || []) {
        for (const rawFile of folder.files || []) {
          if (rawFile.available === false) {
            continue;
          }
          const file = rawFile.folder ? rawFile : { ...rawFile, folder: folder.name };
          const searchText = [
            folder.name,
            folder.label,
            file.key,
            file.path,
            file.name,
            file.label,
            file.folder
          ].join(" ").toLowerCase();
          if (!searchText.includes(normalized)) {
            continue;
          }
          let score = 0;
          if (file.demo || file.engine) {
            score += 100;
          }
          if (normalizedDemoLibraryName(folder.name) === normalized) {
            score += 40;
          }
          if (/walk|walking/.test(searchText)) {
            score += 20;
          }
          if (String(file.extension || "").toLowerCase() === "glb") {
            score += 5;
          }
          candidates.push({ file, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.file || null;
    },

    tutorialDemoFolderLabel(demoName = "cat") {
      return normalizedDemoLibraryName(demoName) === "cat" ? BUILT_IN_DEMO_LIBRARY_FOLDER.label : String(demoName || "Demo");
    },

    tutorialDemoAnimationLibraryFolder(demoName = "cat") {
      const labelKey = normalizedDemoLibraryName(this.tutorialDemoFolderLabel(demoName));
      return (this.animationLibraryFolders || []).find((folder) => folder.name === this.tutorialDemoLibraryFolderName)
        || (this.animationLibraryFolders || []).find((folder) => (
          normalizedDemoLibraryName(folder.label || folder.name) === labelKey
          || normalizedDemoLibraryName(folder.name) === labelKey
        ))
        || null;
    },

    rememberTutorialDemoAnimationLibraryFolder(folderName) {
      if (this.tutorialDemoAnimationLibraryName() !== "cat" || !folderName) {
        return false;
      }
      this.tutorialDemoLibraryFolderName = folderName;
      return true;
    },

    resetTutorialDemoSceneForImportStep(demoName = "cat") {
      const normalized = normalizedDemoLibraryName(demoName) || "cat";
      if (this.tutorialDemoAnimationLibraryName() !== normalized || (!this.model && !this.activeClipEntry)) {
        return false;
      }
      this.loadToken = (this.loadToken || 0) + 1;
      this.clearActorModel?.();
      this.populateBoneSelect?.();
      this.renderActionOptions?.();
      this.syncTimelineControls?.();
      this.updateTimelineKeyMarkers?.();
      this.syncPatchJson?.();
      this.syncExportButtons?.();
      if (this.source) {
        this.source.textContent = "Import a raw Mixamo FBX to begin";
      }
      return true;
    },

    seedTutorialDemoAnimationLibraryFile(demoName = "cat", { resetScene = true } = {}) {
      const normalized = normalizedDemoLibraryName(demoName) || "cat";
      const activeDemoName = this.tutorialDemoAnimationLibraryName();
      if (activeDemoName !== normalized) {
        return false;
      }
      const folderName = this.selectedAnimationLibraryFolderName();
      const existing = this.animationLibraryFolders?.find((folder) => folder.name === folderName);
      if (!existing || folderName !== this.tutorialDemoLibraryFolderName) {
        this.setStatus("Create the Cat Demo folder first");
        return true;
      }
      if (resetScene) {
        this.resetTutorialDemoSceneForImportStep(demoName);
      }
      const demoFolder = builtInDemoLibraryFolder({
        folderName: existing.name,
        label: existing.label || this.tutorialDemoFolderLabel(demoName)
      });
      existing.label ||= demoFolder.label;
      existing.path ||= demoFolder.path;
      const keys = new Set((existing.files || []).map((file) => file.key || file.path || file.name));
      existing.files ||= [];
      existing.files.unshift(
        ...demoFolder.files.filter((file) => !keys.has(file.key || file.path || file.name))
      );
      this.tutorialDemoLibraryImported = true;
      this.animationLibrarySelectedFolder = existing.name;
      this.renderAnimationLibrary();
      this.renderCharacterOptions?.();
      this.setStatus("Imported humanoid-cat-walking into the tutorial folder");
      return true;
    },

    async ensureTutorialDemoAnimationLibraryFile(demoName = "cat") {
      const normalized = normalizedDemoLibraryName(demoName) || "cat";
      if (this.tutorialDemoAnimationLibraryName() !== normalized) {
        return false;
      }
      let folder = this.tutorialDemoAnimationLibraryFolder(demoName);
      if (!folder) {
        const created = await this.createAnimationLibraryFolder?.(this.tutorialDemoFolderLabel(demoName) || "Cat Demo");
        if (!created) {
          return false;
        }
        folder = this.tutorialDemoAnimationLibraryFolder(demoName);
      }
      if (!folder) {
        return false;
      }
      this.tutorialDemoLibraryFolderName = folder.name;
      this.animationLibrarySelectedFolder = folder.name;
      if (this.animationLibraryFolderSelect && !this.animationLibraryFolderSelect.disabled) {
        this.animationLibraryFolderSelect.value = folder.name;
      }
      this.seedTutorialDemoAnimationLibraryFile(demoName, { resetScene: false });
      return Boolean(this.demoAnimationLibraryFile(demoName));
    },

    async ensureTutorialDemoModelLoaded(demoName = "cat") {
      const normalized = normalizedDemoLibraryName(demoName) || "cat";
      if (this.tutorialDemoAnimationLibraryName() !== normalized) {
        return false;
      }
      if (this.model || this.activeClipEntry) {
        return true;
      }
      const imported = await this.ensureTutorialDemoAnimationLibraryFile?.(demoName);
      if (!imported) {
        this.setStatus("Cat demo is not available");
        return false;
      }
      const item = this.demoAnimationLibraryFile?.(demoName);
      if (!item) {
        this.setStatus("Cat demo is not available");
        return false;
      }
      return this.restoreAnimationLibraryFile?.(item, {
        statusVerb: "Loaded demo"
      }) || false;
    },

    syncAnimationLibrarySelectionToFile(item) {
      const folderName = item?.folder || "";
      if (!folderName) {
        return;
      }
      this.animationLibrarySelectedFolder = folderName;
      if (this.animationLibraryFolderSelect && !this.animationLibraryFolderSelect.disabled) {
        this.animationLibraryFolderSelect.value = folderName;
      }
      this.renderAnimationLibrary();
      this.renderCharacterOptions?.();
    },

    async restoreAnimationLibraryFile(item, { silent = false, statusVerb = "Restored" } = {}) {
      if (!item || this.restoringAnimationLibraryFile || this.model || this.activeClipEntry) {
        return false;
      }
      this.syncAnimationLibrarySelectionToFile(item);
      this.restoringAnimationLibraryFile = true;
      try {
        const loaded = await this.loadAnimationLibraryAsset(item);
        if (!loaded) {
          return false;
        }
        if (!silent) {
          this.setStatus(`${statusVerb} ${item.label || item.name}`);
        }
        return true;
      } finally {
        this.restoringAnimationLibraryFile = false;
      }
    },

    async restoreLastAnimationLibraryFile({ silent = false } = {}) {
      return this.restoreAnimationLibraryFile(this.lastAnimationLibraryFile(), { silent });
    },

    showAnimationLibrarySaveAsControls() {
      if (!this.selectedAnimationLibraryFolderName()) {
        this.setStatus("Choose an animation folder first");
        return false;
      }
      if (!this.animationLibrarySaveAsRow || !this.animationLibrarySaveAsNameInput) {
        return false;
      }
      this.animationLibrarySaveAsRow.hidden = false;
      this.animationLibrarySaveAsNameInput.value = this.animationLibrarySaveAsSuggestedName();
      window.requestAnimationFrame(() => {
        this.animationLibrarySaveAsNameInput?.focus();
        this.animationLibrarySaveAsNameInput?.select();
      });
      return true;
    },

    hideAnimationLibrarySaveAsControls() {
      if (this.animationLibrarySaveAsRow) {
        this.animationLibrarySaveAsRow.hidden = true;
      }
    },

    async confirmAnimationLibrarySaveAs() {
      const name = this.animationLibrarySaveAsNameInput?.value || "";
      if (!name.trim()) {
        this.setStatus("Name the new cleanup file first");
        this.animationLibrarySaveAsNameInput?.focus();
        return false;
      }
      const saved = await this.savePatchFile({ saveAs: true, saveAsName: name });
      if (saved) {
        this.hideAnimationLibrarySaveAsControls();
      }
      return saved;
    },

    animationLibrarySaveAsSuggestedName() {
      const label = this.activeClipEntry?.name
        || this.activeClipEntry?.id
        || this.actorTarget?.label
        || this.patchFileName?.()
        || "animation";
      return String(label)
        .replace(/\.[^.]+$/, "")
        .replace(/-weight-patch$/i, "")
        .trim();
    }
  });
}
