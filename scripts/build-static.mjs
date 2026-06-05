import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");

function normalizedRelativePath(path) {
  return relative(root, path).split(sep).join("/");
}

function shouldCopyAsset(source) {
  const relativePath = normalizedRelativePath(source);
  if (relativePath.endsWith("/.DS_Store") || relativePath.endsWith(".DS_Store")) {
    return false;
  }
  if (relativePath.startsWith("assets/models/animation-library/")) {
    return relativePath === "assets/models/animation-library/.gitkeep"
      || relativePath === "assets/models/animation-library/cat"
      || relativePath.startsWith("assets/models/animation-library/cat/");
  }
  return true;
}

async function copyPath(from, to, options = {}) {
  await cp(join(root, from), join(dist, to), {
    recursive: true,
    force: true,
    filter: options.filter || (() => true)
  });
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await copyPath("index.html", "index.html");
await copyPath("src", "src");
await copyPath("assets", "assets", { filter: shouldCopyAsset });
await copyPath("node_modules/three", "node_modules/three");
await copyPath("node_modules/@fourthtemple/fbx-exporter", "node_modules/@fourthtemple/fbx-exporter");
await writeFile(join(dist, ".nojekyll"), "");

console.log(`Built static site in ${normalizedRelativePath(dist)}`);
