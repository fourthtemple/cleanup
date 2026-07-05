import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

function readSource(path) {
  return readFileSync(join(root, path), "utf8");
}

test("legacy projected/WebGL airbrush aggregate has been retired from the default suite", () => {
  const installSource = readSource("src/weight-editor/airbrush/install.js");
  const indexSource = readSource("src/weight-editor/airbrush/index.js");
  const projectedWrapperSource = readSource("src/weight-editor/airbrush/projected-paint.js");

  assert.doesNotMatch(installSource, /webgl-backend|webgl-materials|webgl-project/i);
  assert.doesNotMatch(indexSource, /webgl-backend|webgl-materials|webgl-project/i);
  assert.match(installSource, /installTextureAirbrushVisibleSurfacePaintMethods/);
  assert.match(projectedWrapperSource, /visible-surface-paint/);
  assert.doesNotMatch(projectedWrapperSource, /textureAirbrushGpuProjectFromEvent/);
});
