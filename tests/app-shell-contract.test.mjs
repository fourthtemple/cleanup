import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function indexHtml() {
  return fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
}

function sectionText(html, label) {
  const sectionStart = html.indexOf(`<span class="viewer-label">${label}</span>`);
  assert.notEqual(sectionStart, -1, `missing ${label} section`);
  const nextSection = html.indexOf("<section", sectionStart + 1);
  return html.slice(sectionStart, nextSection === -1 ? html.length : nextSection);
}

test("app shell keeps camera controls separate from background display settings", () => {
  const html = indexHtml();
  const camera = sectionText(html, "Camera");
  const background = sectionText(html, "Background");

  assert.match(camera, /id="camera-gizmo-toggle"/);
  assert.match(camera, /Camera gizmo/);
  assert.doesNotMatch(camera, /id="camera-background-color"/);
  assert.doesNotMatch(camera, /id="camera-mesh-color"/);

  assert.match(background, /id="camera-background-color"/);
  assert.match(background, /id="camera-mesh-color"/);
  assert.match(background, /id="camera-ambient-light"/);
  assert.match(background, /id="camera-key-light"/);
  assert.match(background, /id="camera-rim-light"/);
  assert.match(background, /id="camera-texture-gain"/);
});

test("app shell exposes the camera gizmo stage control once", () => {
  const html = indexHtml();
  assert.equal((html.match(/id="camera-gizmo"/g) || []).length, 1);
  assert.equal((html.match(/id="camera-gizmo-toggle"/g) || []).length, 1);
  assert.equal((html.match(/data-camera-axis=/g) || []).length, 3);
});

test("animation library exposes an explicit motion conversion action", () => {
  const html = indexHtml();
  const animationLibrary = sectionText(html, "Animation Library");

  assert.match(animationLibrary, /id="motion-conversion-mode"/);
  assert.match(animationLibrary, /id="motion-conversion-apply"/);
  assert.match(animationLibrary, />Convert<\/button>/);
});
