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

function modelCleanupEditorSource() {
  return fs.readFileSync(path.join(repoRoot, "src/model-cleanup-editor.js"), "utf8");
}

function animationViewerCss() {
  return fs.readFileSync(path.join(repoRoot, "src/animation-viewer.css"), "utf8");
}

function packageJson() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function sectionText(html, label) {
  const sectionStart = html.indexOf(`<span class="viewer-label">${label}</span>`);
  assert.notEqual(sectionStart, -1, `missing ${label} section`);
  const nextSection = html.indexOf("<section", sectionStart + 1);
  return html.slice(sectionStart, nextSection === -1 ? html.length : nextSection);
}

test("app shell uses Cleanup as the public product name", () => {
  const html = indexHtml();

  assert.match(html, /<title>Fourth Temple Cleanup<\/title>/);
  assert.match(html, /aria-label="Fourth Temple Cleanup controls"/);
  assert.match(html, /<h1>Cleanup<\/h1>/);
  assert.match(html, /<h2 id="tutorial-title">Cleanup Recipes<\/h2>/);
});

test("app shell keeps camera controls separate from background display settings", () => {
  const html = indexHtml();
  const camera = sectionText(html, "Camera");
  const background = sectionText(html, "Background");
  const settings = sectionText(html, "Settings");

  assert.match(camera, /id="camera-gizmo-toggle"/);
  assert.match(camera, /Camera gizmo/);
  assert.match(camera, /id="save-orbit-view"/);
  assert.match(camera, /id="restore-orbit-view"/);
  assert.match(camera, /<span class="viewer-subheading">View<\/span>/);
  assert.match(camera, /<button id="save-orbit-view"[^>]*>Save<\/button>/);
  assert.match(camera, /<button id="restore-orbit-view"[^>]*>Restore<\/button>/);
  assert.doesNotMatch(camera, />Save View<\/button>/);
  assert.doesNotMatch(camera, />Restore View<\/button>/);
  assert.doesNotMatch(camera, /id="camera-background-color"/);
  assert.doesNotMatch(camera, /id="camera-mesh-color"/);

  assert.match(background, /id="camera-background-color"/);
  assert.match(background, /id="camera-mesh-color"/);
  assert.match(background, /id="camera-ambient-light"/);
  assert.match(background, /id="camera-key-light"/);
  assert.match(background, /id="camera-rim-light"/);
  assert.match(background, /id="camera-texture-gain"/);

  assert.doesNotMatch(settings, /id="save-orbit-view"/);
  assert.doesNotMatch(settings, /id="restore-orbit-view"/);
});

test("app shell exposes the camera gizmo stage control once", () => {
  const html = indexHtml();
  assert.equal((html.match(/id="camera-gizmo"/g) || []).length, 1);
  assert.equal((html.match(/id="camera-gizmo-toggle"/g) || []).length, 1);
  assert.equal((html.match(/data-camera-axis=/g) || []).length, 3);
});

test("selected native select options stay readable", () => {
  const css = animationViewerCss();

  assert.match(css, /select option:checked \{[\s\S]*color: #fff;/);
  assert.match(css, /select option:checked \{[\s\S]*-webkit-text-fill-color: #fff;/);
  assert.match(css, /select option:checked \{[\s\S]*font-weight: 700;/);
  assert.match(css, /select option:checked \{[\s\S]*box-shadow: 0 0 0 100vmax #6f5118 inset;/);
});

test("animation library exposes an explicit motion conversion action", () => {
  const html = indexHtml();
  const animationLibrary = sectionText(html, "Animation Library");

  assert.match(animationLibrary, /id="motion-conversion-mode"/);
  assert.match(animationLibrary, /id="motion-conversion-apply"/);
  assert.match(animationLibrary, />Convert<\/button>/);
});

test("airbrush controls expose per-parameter pressure toggles", () => {
  const html = indexHtml();
  const airbrush = sectionText(html, "Airbrush");

  assert.match(airbrush, /id="texture-pressure-radius" type="checkbox" checked/);
  assert.doesNotMatch(airbrush, /id="texture-pressure-opacity" type="checkbox" checked/);
  assert.match(airbrush, /id="texture-eraser-tool" type="button" data-tool="texture-eraser"/);
  assert.match(airbrush, /id="texture-neighbor-toggle" type="checkbox"[\s\S]*Airbrush radius/);
  assert.match(airbrush, /id="texture-brush-opacity"[\s\S]*id="texture-brush-spacing"/);
  assert.match(airbrush, /id="texture-brush-spacing" type="range" min="0\.1" max="200" step="0\.1" value="1"/);
  assert.doesNotMatch(airbrush, /id="texture-pressure-hardness"/);
  assert.doesNotMatch(airbrush, /id="texture-pressure-scatter"/);
});

test("app shell exposes Photoshop-style texture layer controls", () => {
  const html = indexHtml();
  const layers = sectionText(html, "Layers");

  assert.match(layers, /id="texture-layer-add"/);
  assert.match(layers, /id="texture-layer-duplicate"/);
  assert.match(layers, /id="texture-layer-merge"/);
  assert.match(layers, /id="texture-layer-move-up"/);
  assert.match(layers, /id="texture-layer-move-down"/);
  assert.match(layers, /id="texture-layer-delete"/);
  assert.match(layers, /id="texture-layer-blend"[\s\S]*Normal/);
  assert.match(layers, /id="texture-layer-blend"[\s\S]*Multiply[\s\S]*Screen[\s\S]*Overlay/);
  assert.match(layers, /id="texture-layer-blend"[\s\S]*Color Dodge[\s\S]*Color Burn[\s\S]*Luminosity/);
  assert.match(layers, /id="texture-layer-opacity" type="range"/);
  assert.match(layers, /id="texture-layer-list" class="texture-layer-list"/);
});

test("app exposes a WebGPU airbrush runtime diagnostic helper", () => {
  const source = modelCleanupEditorSource();

  assert.match(source, /window\.modelCleanupEditor = this/);
  assert.match(source, /window\.modelCleanupWebGpuStatus = \(\) => this\.textureAirbrushWebGpuRuntimeStatus\?\.\(\) \|\| null/);
  assert.match(source, /window\.modelCleanupWebGpuSelfTest = \(options = \{\}\) => this\.textureAirbrushRunWebGpuSelfTest\?\.\(options\) \|\| Promise\.resolve\(null\)/);
});

test("package exposes native airbrush validation commands", () => {
  const manifest = packageJson();

  assert.equal(manifest.scripts["validate:airbrush"], "node ./scripts/validate-airbrush-runtime.mjs");
  assert.equal(
    manifest.scripts["validate:airbrush-after-orbit-neighbor"],
    "node ./scripts/validate-airbrush-runtime.mjs --after-orbit-neighbor --timeout 90000"
  );
  assert.equal(manifest.scripts["validate:webgpu-airbrush"], "node ./scripts/validate-webgpu-airbrush.mjs");
});

test("tutorial recipes explain curve editing and motion conversion", () => {
  const html = indexHtml();

  assert.match(html, /<h3>Curve Editor<\/h3>/);
  assert.match(html, /<h3>Motion Conversion<\/h3>/);
  assert.match(html, /before opening a model/);
  assert.match(html, /Convert<\/b> while editing/);
  assert.match(html, /data-tutorial-action="open-timeline-drawer"/);
  assert.match(html, /Select a keyed bone such as <b>Left Shoulder<\/b>/);
  assert.match(html, /Solved keys/);
  assert.match(html, /Adaptive keys/);
  assert.match(html, /Additive kinematics/);
  assert.match(html, /unkeyed FK\/IK poses are ignored/);
});
