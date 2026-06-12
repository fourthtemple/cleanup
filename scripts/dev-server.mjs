import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const initialEnvKeys = new Set(Object.keys(process.env));
await loadLocalEnv(root, initialEnvKeys);
const requestedPort = parseRequestedPort(process.env.PORT);
const animationLibraryRoot = resolve(root, "assets/models/animation-library");
const tutorialMacroAssetPath = resolve(root, "assets/tutorial-macros.json");
const tutorialRecipeAssetPath = resolve(root, "assets/tutorial-recipes.json");
const animationFileExtensions = new Set([".fbx", ".glb", ".gltf"]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".fbx": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/animation-library") {
      await listAnimationLibrary(response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/animation-library/folder") {
      await createAnimationLibraryFolder(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/animation-library/upload") {
      await uploadAnimationLibraryFile(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/animation-library/delete") {
      await deleteAnimationLibraryFile(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/animation-library/folder/delete") {
      await deleteAnimationLibraryFolder(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/animation-library/cleanup") {
      await saveAnimationLibraryCleanup(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/tutorial-macros") {
      await saveTutorialMacros(request, response);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/tutorial-recipes") {
      await saveTutorialRecipes(request, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || "Server error" });
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`Fourth Temple Model Cleanup dev server: http://127.0.0.1:${port}/`);
});

function parseRequestedPort(value) {
  if (value === undefined || value === "") {
    return 0;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, received "${value}"`);
  }

  return port;
}

async function loadLocalEnv(rootDir, explicitEnvKeys) {
  for (const fileName of [".env", ".env.local"]) {
    let text = "";
    try {
      text = await readFile(resolve(rootDir, fileName), "utf8");
    } catch {
      continue;
    }

    for (const [key, value] of parseEnvFile(text)) {
      if (!explicitEnvKeys.has(key)) {
        process.env[key] = value;
      }
    }
  }
}

function parseEnvFile(text) {
  const entries = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    entries.push([match[1], unquoteEnvValue(match[2])]);
  }
  return entries;
}

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function listAnimationLibrary(response) {
  await mkdir(animationLibraryRoot, { recursive: true });
  const entries = await readdir(animationLibraryRoot, { withFileTypes: true });
  const folders = [];

  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const folderPath = resolve(animationLibraryRoot, entry.name);
    if (!folderPath.startsWith(`${animationLibraryRoot}${sep}`)) {
      continue;
    }

    const fileEntries = await readdir(folderPath, { withFileTypes: true });
    const files = fileEntries
      .filter((item) => item.isFile() && animationFileExtensions.has(extname(item.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => animationLibraryFileDescriptor(entry.name, file.name));

    folders.push({
      name: entry.name,
      label: entry.name,
      path: `assets/models/animation-library/${entry.name}`,
      files
    });
  }

  sendJson(response, 200, {
    root: "assets/models/animation-library",
    folders
  });
}

async function createAnimationLibraryFolder(request, response) {
  const payload = await readJsonRequest(request, 64 * 1024);
  const folderName = sanitizeLibraryFolderName(payload.folder || payload.name);
  if (!folderName) {
    sendJson(response, 400, { error: "Folder name is required" });
    return;
  }

  const folderPath = resolveAnimationLibraryFolder(folderName);
  if (!folderPath) {
    sendJson(response, 403, { error: "Invalid animation folder" });
    return;
  }

  await mkdir(folderPath, { recursive: true });
  sendJson(response, 200, {
    ok: true,
    folder: {
      name: folderName,
      path: `assets/models/animation-library/${folderName}`
    }
  });
}

async function uploadAnimationLibraryFile(request, response) {
  const payload = await readJsonRequest(request, 192 * 1024 * 1024);
  const folderName = sanitizeLibraryFolderName(payload.folder);
  const fileName = sanitizeAnimationFileName(payload.fileName);
  if (!folderName || !fileName) {
    sendJson(response, 400, { error: "Folder and animation file name are required" });
    return;
  }

  const folderPath = resolveAnimationLibraryFolder(folderName);
  if (!folderPath) {
    sendJson(response, 403, { error: "Invalid animation folder" });
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(String(payload.contentBase64 || ""), "base64");
  } catch {
    sendJson(response, 400, { error: "Animation content must be base64" });
    return;
  }
  if (!buffer.length) {
    sendJson(response, 400, { error: "Animation file is empty" });
    return;
  }

  await mkdir(folderPath, { recursive: true });
  const destination = resolve(folderPath, fileName);
  if (!destination.startsWith(`${folderPath}${sep}`)) {
    sendJson(response, 403, { error: "Invalid animation file path" });
    return;
  }

  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, buffer);
  await rename(temporary, destination);
  sendJson(response, 200, {
    ok: true,
    folder: folderName,
    file: animationLibraryFileDescriptor(folderName, fileName),
    bytes: buffer.length
  });
}

async function deleteAnimationLibraryFile(request, response) {
  const payload = await readJsonRequest(request, 64 * 1024);
  const folderName = sanitizeLibraryFolderName(payload.folder);
  const fileName = sanitizeAnimationFileName(payload.fileName || payload.name);
  if (!folderName || !fileName) {
    sendJson(response, 400, { error: "Folder and animation file name are required" });
    return;
  }

  const folderPath = resolveAnimationLibraryFolder(folderName);
  if (!folderPath) {
    sendJson(response, 403, { error: "Invalid animation folder" });
    return;
  }

  const destination = resolve(folderPath, fileName);
  if (!destination.startsWith(`${folderPath}${sep}`)) {
    sendJson(response, 403, { error: "Invalid animation file path" });
    return;
  }

  try {
    await unlink(destination);
  } catch {
    sendJson(response, 404, { error: "Animation file not found" });
    return;
  }

  const cleanupFile = animationLibraryCleanupFileName(fileName);
  const cleanupDestination = resolve(folderPath, cleanupFile);
  let cleanupDeleted = false;
  if (cleanupDestination.startsWith(`${folderPath}${sep}`)) {
    try {
      await unlink(cleanupDestination);
      cleanupDeleted = true;
    } catch {
      cleanupDeleted = false;
    }
  }

  sendJson(response, 200, {
    ok: true,
    folder: folderName,
    fileName,
    path: `assets/models/animation-library/${folderName}/${fileName}`,
    cleanupDeleted
  });
}

async function deleteAnimationLibraryFolder(request, response) {
  const payload = await readJsonRequest(request, 64 * 1024);
  const folderName = sanitizeLibraryFolderName(payload.folder || payload.name);
  if (!folderName) {
    sendJson(response, 400, { error: "Folder name is required" });
    return;
  }

  const folderPath = resolveAnimationLibraryFolder(folderName);
  if (!folderPath) {
    sendJson(response, 403, { error: "Invalid animation folder" });
    return;
  }

  try {
    await rm(folderPath, { recursive: true, force: false });
  } catch {
    sendJson(response, 404, { error: "Animation folder not found" });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    folder: folderName,
    path: `assets/models/animation-library/${folderName}`
  });
}

async function saveAnimationLibraryCleanup(request, response) {
  const payload = await readJsonRequest(request, 16 * 1024 * 1024);
  const folderName = sanitizeLibraryFolderName(payload.folder);
  const fileName = sanitizeLibraryJsonFileName(payload.fileName);
  if (!folderName || !fileName) {
    sendJson(response, 400, { error: "Folder and cleanup file name are required" });
    return;
  }

  const folderPath = resolveAnimationLibraryFolder(folderName);
  if (!folderPath) {
    sendJson(response, 403, { error: "Invalid animation folder" });
    return;
  }

  const content = typeof payload.content === "string"
    ? payload.content
    : `${JSON.stringify(payload.content, null, 2)}\n`;
  try {
    JSON.parse(content);
  } catch {
    sendJson(response, 400, { error: "Saved cleanup must be valid JSON" });
    return;
  }

  await mkdir(folderPath, { recursive: true });
  const destination = resolve(folderPath, fileName);
  if (!destination.startsWith(`${folderPath}${sep}`)) {
    sendJson(response, 403, { error: "Invalid cleanup file path" });
    return;
  }

  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, destination);
  sendJson(response, 200, {
    ok: true,
    folder: folderName,
    fileName,
    path: `assets/models/animation-library/${folderName}/${fileName}`,
    bytes: Buffer.byteLength(content, "utf8")
  });
}

async function saveTutorialMacros(request, response) {
  const payload = await readJsonRequest(request, 64 * 1024 * 1024);
  const macros = payload?.macros;
  if (!macros || typeof macros !== "object" || Array.isArray(macros)) {
    sendJson(response, 400, { error: "Tutorial macros payload requires a macros object" });
    return;
  }

  const content = `${JSON.stringify({
    version: 1,
    app: "Fourth Temple Model Cleanup",
    updatedAt: new Date().toISOString(),
    macros
  }, null, 2)}\n`;
  JSON.parse(content);
  await writeAssetJson(tutorialMacroAssetPath, content);
  sendJson(response, 200, {
    ok: true,
    path: "assets/tutorial-macros.json",
    macros: Object.keys(macros).sort(),
    bytes: Buffer.byteLength(content, "utf8")
  });
}

async function saveTutorialRecipes(request, response) {
  const payload = await readJsonRequest(request, 4 * 1024 * 1024);
  const cards = Array.isArray(payload?.cards) ? payload.cards : null;
  if (!cards) {
    sendJson(response, 400, { error: "Tutorial recipes payload requires a cards array" });
    return;
  }

  const content = `${JSON.stringify({
    version: 1,
    app: "Fourth Temple Model Cleanup",
    updatedAt: new Date().toISOString(),
    cards
  }, null, 2)}\n`;
  JSON.parse(content);
  await writeAssetJson(tutorialRecipeAssetPath, content);
  sendJson(response, 200, {
    ok: true,
    path: "assets/tutorial-recipes.json",
    cards: cards.length,
    bytes: Buffer.byteLength(content, "utf8")
  });
}

async function writeAssetJson(destination, content) {
  if (!destination.startsWith(`${resolve(root, "assets")}${sep}`)) {
    const error = new Error("Invalid asset path");
    error.statusCode = 403;
    throw error;
  }
  await mkdir(resolve(root, "assets"), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, destination);
}

function animationLibraryFileDescriptor(folderName, fileName) {
  const relativePath = `assets/models/animation-library/${folderName}/${fileName}`;
  const cleanupFile = animationLibraryCleanupFileName(fileName);
  const cleanupPath = `assets/models/animation-library/${folderName}/${cleanupFile}`;
  return {
    key: relativePath,
    name: fileName,
    extension: extname(fileName).slice(1).toLowerCase() || "anim",
    folder: folderName,
    path: relativePath,
    url: `./${relativePath}`,
    cleanupFile,
    cleanupPath,
    cleanupUrl: `./${cleanupPath}`
  };
}

function animationLibraryCleanupFileName(fileName) {
  return `${fileName.replace(/\.[^.]+$/, "")}-weight-patch.json`;
}

function resolveAnimationLibraryFolder(folderName) {
  const folderPath = resolve(animationLibraryRoot, folderName);
  if (!folderPath.startsWith(`${animationLibraryRoot}${sep}`)) {
    return null;
  }
  return folderPath;
}

function sanitizeLibraryFolderName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

function sanitizeAnimationFileName(value) {
  const raw = String(value || "").trim();
  const extension = extname(raw).toLowerCase();
  if (!animationFileExtensions.has(extension)) {
    return "";
  }
  const base = raw
    .slice(0, -extension.length)
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120)
    .toLowerCase();
  return base ? `${base}${extension}` : `animation${extension}`;
}

function sanitizeLibraryJsonFileName(value) {
  const raw = String(value || "").trim();
  if (extname(raw).toLowerCase() !== ".json") {
    return "";
  }
  const base = raw
    .slice(0, -5)
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120)
    .toLowerCase();
  return base ? `${base}.json` : "";
}

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const cleanPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(root, `.${cleanPath}`);
  if (!filePath.startsWith(root)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let info;
  try {
    info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath);
    }
  } catch {
    sendText(response, 404, "Not found");
    return;
  }

  const headers = {
    "Cache-Control": "no-store",
    "Content-Length": info.size,
    "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream"
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function readJsonRequest(request, limit) {
  const body = await readRequestBody(request, limit);
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function readRequestBody(request, limit) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > limit) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
  }
  return body;
}

function sendJson(response, status, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text, "utf8"),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(text);
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text, "utf8"),
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(text);
}
