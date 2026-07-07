import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("src/texture-paint/surface-airbrush-tsl.js");
const source = fs.readFileSync(sourcePath, "utf8");
const validatorPath = path.resolve("scripts/validate-airbrush-runtime.mjs");
const validatorSource = fs.readFileSync(validatorPath, "utf8");

function functionSource(name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} not found`);
  const signatureEnd = source.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `${name} signature was not closed`);
  let depth = 0;
  const bodyStart = source.indexOf("{", signatureEnd);
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`${name} body was not closed`);
}

test("TSL layer composite shader exposes every texture paint blend mode", () => {
  const body = functionSource("createLayerCompositeMaterial");

  for (const mode of [
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity"
  ]) {
    const key = /^[a-z]+$/.test(mode) ? mode : JSON.stringify(mode);
    assert.match(source, new RegExp(`${key}:\\s*\\d+`));
  }

  assert.match(body, /const blendMode = uniform\(0, "float"\)/);
  assert.match(body, /const multiplyBlend = baseRgb\.mul\(layerRgb\)/);
  assert.match(body, /const screenBlend = float\(1\)\.sub/);
  assert.match(body, /const overlayBlend = vec3/);
  assert.match(body, /const colorDodgeBlend = vec3/);
  assert.match(body, /const colorBurnBlend = vec3/);
  assert.match(body, /const softLightBlend = vec3/);
  assert.match(body, /const hueBlend = setLum\(setSat\(layerRgb, baseSat\), baseLum\)/);
  assert.match(body, /const saturationBlend = setLum\(setSat\(baseRgb, layerSat\), baseLum\)/);
  assert.match(body, /const colorBlend = setLum\(layerRgb, baseLum\)/);
  assert.match(body, /const luminosityBlend = setLum\(baseRgb, layerLum\)/);
  assert.match(body, /blendedRgb\.assign\(modeEnabled\(15\)\.select\(luminosityBlend, blendedRgb\)\)/);
});

test("TSL layer composite receives blend mode from lower and active layers", () => {
  const underlayBody = functionSource("surfaceLayerCompositeUnderlayTexture");
  const updateBody = functionSource("updateLayerCompositeMaterial");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  const exposeBody = functionSource("exposeSurfaceRunDebug");

  assert.match(updateBody, /state\.blendMode\.value = surfaceLayerBlendModeCode\(options\.blendMode\)/);
  assert.match(underlayBody, /blendMode: layer\?\.blendMode \|\| "normal"/);
  assert.match(runBody, /blendMode: editable\.layer\?\.blendMode \|\| "normal"/);
  assert.match(runBody, /tslSurfaceLayerBlendMode: editable\?\.layer\?\.blendMode \|\| "normal"/);
  assert.match(exposeBody, /layerBlendMode: stats\.tslSurfaceLayerBlendMode \|\| "normal"/);
});

test("visual matrix proof exercises a non-normal live layer blend mode", () => {
  assert.match(
    validatorSource,
    /setTexturePaintLayerBlendMode\?\.\(newLayer\.id, "multiply"\)/
  );
  assert.match(
    validatorSource,
    /result\?\.twoLayer\?\.stroke\?\.stats\?\.tslSurfaceLayerBlendMode === "multiply"/
  );
});
