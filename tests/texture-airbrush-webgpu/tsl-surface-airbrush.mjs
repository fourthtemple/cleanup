import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "../../node_modules/three/build/three.webgpu.js";
import {
  TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER,
  TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_CORE_MIN_SCALE,
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE,
  TEXTURE_AIRBRUSH_SOFT_HALO_SCALE
} from "../../src/weight-editor/airbrush/math.js";
import {
  buildSurfaceUvOwnershipMask,
  SURFACE_UV_OWNERSHIP_DISTANCE_THRESHOLD,
  SURFACE_UV_OWNERSHIP_MASK_SIZE
} from "../../src/texture-paint/surface-airbrush/uv-ownership.js";
import { surfaceProjectionRecord } from "../../src/texture-paint/surface-airbrush/projection-record.js";
import {
  setSurfaceBrushColorUniform,
  surfaceBrushWorkingColor
} from "../../src/texture-paint/surface-airbrush/color.js";
import {
  SURFACE_STROKE_MASK_MAX_SIZE,
  surfaceStrokeMaskSize
} from "../../src/texture-paint/surface-airbrush/performance.js";
import {
  surfaceAirbrushCachedTextureStillBound,
  surfaceStrokeStartsNewStroke
} from "../../src/texture-paint/surface-airbrush-tsl.js";
import {
  locallyConnectedSourceRasterTriangles,
  sourceRasterTopologyKey,
  sourceRasterTriangleAllowsVisibleFace,
  sourceRasterVisibleFaceIndices,
  sourceRasterVisibleFaceKey,
  sourceRasterVisibleFaceSet
} from "../../src/texture-paint/source-raster-topology.js";

const source = readFileSync(new URL("../../src/texture-paint/surface-airbrush-tsl.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../../src/texture-paint/surface-airbrush/core.js", import.meta.url), "utf8");
const uvOwnershipSource = readFileSync(new URL("../../src/texture-paint/surface-airbrush/uv-ownership.js", import.meta.url), "utf8");
const projectionRecordSource = readFileSync(new URL("../../src/texture-paint/surface-airbrush/projection-record.js", import.meta.url), "utf8");
const strokeSource = readFileSync(new URL("../../src/weight-editor/airbrush/webgpu-stroke.js", import.meta.url), "utf8");
const liveSource = readFileSync(new URL("../../src/weight-editor/airbrush/webgpu-live.js", import.meta.url), "utf8");
const projectionSource = readFileSync(new URL("../../src/weight-editor/airbrush/webgpu-projection.js", import.meta.url), "utf8");
const neighborSource = readFileSync(new URL("../../src/weight-editor/airbrush/neighbor.js", import.meta.url), "utf8");
const clonePaintSource = readFileSync(new URL("../../src/weight-editor/clone-paint.js", import.meta.url), "utf8");
const paintToolsSource = readFileSync(new URL("../../src/weight-editor/paint-tools.js", import.meta.url), "utf8");

function sourceFunction(sourceText, name) {
  const start = sourceText.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = sourceText.indexOf("\nfunction ", start + 1);
  return sourceText.slice(start, next === -1 ? undefined : next);
}

function functionSource(name) {
  const sourceText = [source, coreSource, uvOwnershipSource, projectionRecordSource]
    .find((candidate) => candidate.includes(`function ${name}`));
  assert.ok(sourceText, `${name} should exist in the surface airbrush modules`);
  return sourceFunction(sourceText, name);
}

function objectMethodSource(sourceText, name) {
  const start = sourceText.indexOf(`    ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = sourceText.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${name} should have a body`);
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(start, index + 1);
      }
    }
  }
  return sourceText.slice(start);
}

test("Neighbor source raster keeps only the locally connected brush patch", () => {
  const local = { id: "local", vertexIndices: [0, 1, 2] };
  const seamContinuation = { id: "seam", vertexIndices: [10, 3, 4] };
  const insetArm = { id: "arm", vertexIndices: [20, 21, 22] };
  const seamMap = new Map([
    [1, [1, 10]],
    [10, [1, 10]]
  ]);
  const options = {
    sourceRasterTopologySeedVertices: new Set([0]),
    sourceRasterTopologyKey: "torso-stroke",
    sourceRasterTopologySerial: 2
  };

  assert.deepEqual(
    locallyConnectedSourceRasterTriangles(
      [local, seamContinuation, insetArm],
      { seamMap },
      options
    ).map((triangle) => triangle.id),
    ["local", "seam"]
  );
  assert.deepEqual(
    locallyConnectedSourceRasterTriangles(
      [insetArm],
      { seamMap },
      options
    ),
    [],
    "a clipped batch must not fall back to an unrelated nearby surface"
  );
  assert.equal(sourceRasterTopologyKey(options), "torso-stroke:2:1");
  const record = {};
  const visibleFaces = sourceRasterVisibleFaceSet([
    { record, faceIndex: 4 },
    { record: {}, faceIndex: 5 }
  ], record, 8);
  const visibleOptions = { sourceRasterVisibleFaceIndices: visibleFaces };
  assert.deepEqual([...visibleFaces].sort((left, right) => left - right), [4, 8]);
  assert.equal(sourceRasterVisibleFaceIndices(visibleOptions), visibleFaces);
  assert.equal(sourceRasterTriangleAllowsVisibleFace(4, visibleOptions), true);
  assert.equal(sourceRasterTriangleAllowsVisibleFace(5, visibleOptions), false);
  assert.match(sourceRasterVisibleFaceKey(visibleOptions), /^visible:2:/);
  assert.match(strokeSource, /sourceRasterTopologySeedVertices: neighborLocalTopologyVertices/);
  assert.match(strokeSource, /textureAirbrushScreenTrianglesNearSegments/);
  assert.match(strokeSource, /sourceRasterVisibleFaceIndices: neighborVisibleTopologyFaces/);
  assert.match(source, /sourceRasterTopologySeedVertices: options\.sourceRasterTopologySeedVertices/);
  assert.match(source, /sourceRasterVisibleFaceIndices: options\.sourceRasterVisibleFaceIndices/);
  assert.match(source, /locallyConnectedSourceRasterTriangles\(triangles, componentState, options\)/);
  const rasterBody = functionSource("sourceUvRasterTriangles");
  assert.match(rasterBody, /const visibleElementStarts = visibleFaceIndices\?\.size[\s\S]*?\[\.\.\.visibleFaceIndices\][\s\S]*?\.sort\(\(left, right\) => left - right\)/);
  assert.match(rasterBody, /const iterationCount = visibleElementStarts[\s\S]*?\? visibleElementStarts\.length[\s\S]*?: Math\.floor\(elementCount \/ 3\)/);
  assert.ok(
    rasterBody.indexOf("sourceRasterTriangleAllowsVisibleFace(faceIndex, options)")
      < rasterBody.indexOf("projectionRecordAt(ia)"),
    "frontmost face filtering should happen before vertex projection"
  );
});

test("TSL surface airbrush keeps the final brush field surface-continuous", () => {
  const body = functionSource("createSurfaceMaterial");
  const sampleIndex = body.indexOf("const surfaceFieldCoverage");
  assert.ok(sampleIndex > -1, "createSurfaceMaterial should derive surface coverage");
  assert.doesNotMatch(body, /const viewDistancePermission/);
  assert.doesNotMatch(body, /const viewDistanceSoftPermission/);
  assert.doesNotMatch(body, /const depthPermission/);
  assert.doesNotMatch(body, /const depthSoftPermission/);
  assert.doesNotMatch(body, /const visibleHardPermission/);
  assert.doesNotMatch(body, /visibilityCoverage|visibleDepthFade|visibleDepthSmoothFade/);
  assert.doesNotMatch(body, /visibleGateCoverage/);
  assert.doesNotMatch(body, /visiblePermission|visibleSoftPermission/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.85\)/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.9\)/);
  assert.doesNotMatch(body, /mix\(visibleSoftPermission, visibleHardPermission, hardVisibleEdge\)/);
  assert.doesNotMatch(body, /visibleOccluded/);
  assert.doesNotMatch(body, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.match(body, /const segmentViewStarts = uniformArray/);
  assert.match(body, /const segmentViewEnds = uniformArray/);
  assert.doesNotMatch(source, /VISIBLE_SURFACE_DEPTH_GATE_/);
  assert.doesNotMatch(body, /const visibleSurfaceWeight = visibleActive\.mul\(visibleSampleValid\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const viewStart = segmentViewStarts\.element\(i\)/);
  assert.doesNotMatch(body, /const viewEnd = segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(body, /const visibleDepthGate =/);
  assert.doesNotMatch(body, /const hasViewSegment = viewStart\.w\.greaterThan\(0\.0001\)/);
  assert.doesNotMatch(body, /const viewRadius = max\(mix\(viewStart\.w, viewEnd\.w, viewT\), 0\.0001\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const viewDistancePixels/);
  assert.doesNotMatch(body, /const viewDistanceCoverage = viewEdgeCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const viewDepthDelta = abs\(editorView\.z\.sub\(viewClosest\.z\)\)\.toVar\(\)/);
  assert.match(body, /const visibleDelta = abs\(fragmentDepth\.sub\(visibleDepth\)\)\.toVar\(\)/);
  assert.doesNotMatch(body, /normalCompatibility/);
  assert.doesNotMatch(body, /surfacePlanePermission/);
  assert.doesNotMatch(body, /normalPlane/);
  assert.match(body, /const segmentComponents = uniformArray/);
  assert.doesNotMatch(body, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(body, /\.mul\(componentPermission\)/);
  assert.doesNotMatch(body, /componentDelta/);
  assert.doesNotMatch(body, /const screenOnlyCoverage = visibleActive\.greaterThan\(0\.5\)/);
  assert.doesNotMatch(body, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(body, /min\(screenCoverage, viewCoverage\)/);
  assert.match(body, /const screenCoverage = edgeCoverage\.toVar\(\)/);
  assert.match(body, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const surfaceCoverage =/);
  assert.doesNotMatch(body, /screenGate/);
  assert.doesNotMatch(body, /surfaceCoverage\.mul\(screenGate\)/);
  assert.doesNotMatch(body, /const viewCoverage = max\(0\.0, float\(1\)\.sub\(viewSmoothEdge\)\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const hasViewGate =/);
  assert.doesNotMatch(source, /SURFACE_VIEW_CONTINUITY_CORE_SCALE/);
  assert.doesNotMatch(source, /SURFACE_VIEW_CONTINUITY_FEATHER_SCALE/);
  assert.doesNotMatch(body, /viewContinuityCoverage|viewContinuityFade|viewContinuitySmoothFade/);
  assert.match(body, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(visibilityCoverage\)/);
  assert.doesNotMatch(body, /const surfaceFieldCoverage = brushFieldCoverage\.mul\(depthGate\)/);
  assert.match(source, /const VISIBLE_SURFACE_OCCLUSION_DEPTH_SOFT_FEATHER = /);
  assert.match(source, /const VISIBLE_SURFACE_CLOSER_DEPTH_TOLERANCE = /);
  assert.match(source, /const VISIBLE_SURFACE_CLOSER_DEPTH_FEATHER = /);
  assert.match(source, /const VISIBLE_SURFACE_SOFT_EDGE_SAMPLE_PIXELS = /);
  assert.match(source, /const VISIBLE_SURFACE_SOFT_EDGE_COVERAGE = /);
  assert.match(body, /const frontmostSurfaceHardCoverage = visibleDepthDelta[\s\S]*?lessThanEqual\(VISIBLE_SURFACE_OCCLUSION_DEPTH_TOLERANCE\)[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const frontmostSurfaceSoftRamp = clamp\([\s\S]*?VISIBLE_SURFACE_OCCLUSION_DEPTH_SOFT_FEATHER[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const frontmostSurfaceCoverage = mix\([\s\S]*?frontmostSurfaceSoftCoverage,[\s\S]*?frontmostSurfaceHardCoverage,[\s\S]*?hardVisibleEdge[\s\S]*?\)\.toVar\(\)/);
  assert.match(body, /const closerDepthRamp = clamp\([\s\S]*?visibleDepthDelta\.mul\(-1\)[\s\S]*?VISIBLE_SURFACE_CLOSER_DEPTH_TOLERANCE[\s\S]*?VISIBLE_SURFACE_CLOSER_DEPTH_FEATHER[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const visibleDepthCoverageBase = frontmostSurfaceCoverage\.mul\(closerDepthCoverage\)\.toVar\(\)/);
  assert.match(body, /const visibleSoftEdgeCoverageForOffset = \(offset\) => max\([\s\S]*?visibleTextureNode\.sample[\s\S]*?vec2\(offset\.x, 0\)[\s\S]*?vec2\(0, offset\.y\)[\s\S]*?\);/);
  assert.match(body, /const visibleSoftEdgeCoverage = max\([\s\S]*?VISIBLE_SURFACE_SOFT_EDGE_COVERAGE[\s\S]*?VISIBLE_SURFACE_SOFT_EDGE_FAR_COVERAGE[\s\S]*?float\(1\)\.sub\(hardVisibleEdge\)[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const visibleDepthCoverage = max\([\s\S]*?visibleDepthCoverageBase,[\s\S]*?visibleSoftEdgeCoverage\.mul\(visibleSampleValid\)[\s\S]*?\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const visibleDepthCoverage = max\(visibleDepthCoverageBase, visibleSoftEdgeCoverage\)\.toVar\(\)/);
  assert.match(body, /const depthGate = mix\(float\(1\), visibleDepthCoverage, visibleActive\)\.toVar\(\)/);
  assert.match(body, /const frontmostSurfaceLocalityAuthority = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?\.mul\(visibleDepthCoverageBase\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /depthGate = mix\(float\(1\), visibleDepthCoverage, visibleActive\.mul\(visibleSampleValid\)\)/);
  assert.doesNotMatch(body, /frontmostSurfaceLocalityAuthority = visibleActive[\s\S]*?\.mul\(visibleDepthCoverage\)[\s\S]*?\.toVar\(\)/);
  assert.match(source, /const SURFACE_AIRBRUSH_SEGMENT_DISTANCE_RADIUS_SCALE = 0\.9/);
  assert.match(source, /const SURFACE_AIRBRUSH_SEGMENT_DISTANCE_FEATHER_SCALE = 0\.35/);
  assert.doesNotMatch(source, /SURFACE_AIRBRUSH_FRONTMOST_DISTANCE_/);
  assert.match(body, /const segmentHasDirectionalView = segmentHasView[\s\S]*?segmentViewLengthRaw\.greaterThan\(0\.000001\)[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const segmentHasPointView = segmentHasView[\s\S]*?segmentViewLengthRaw\.lessThanEqual\(0\.000001\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /frontmostDistanceGate|frontmostDistanceRamp|frontmostDistanceLimit|frontmostDistanceFeather/);
  assert.match(body, /const segmentDepthGate = segmentHasDirectionalView[\s\S]*?\.select\([\s\S]*?segmentDepthFeathered,[\s\S]*?segmentHasPointView\.select\(segmentDepthFeathered, float\(1\)\)[\s\S]*?\)[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const strictSegmentLocalityGate = opposedNormalGate[\s\S]*?\.mul\(segmentDistanceGate\)[\s\S]*?\.mul\(segmentDepthGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /frontmostSegmentLocalityGate/);
  assert.match(body, /const segmentLocalityGate = mix\([\s\S]*?strictSegmentLocalityGate,[\s\S]*?float\(1\),[\s\S]*?frontmostSurfaceLocalityAuthority[\s\S]*?\)\.toVar\(\)/);
  assert.doesNotMatch(body, /segmentNormalGate|segmentViewGate|segmentViewDepthGate/);
  assert.doesNotMatch(body, /SURFACE_AIRBRUSH_SEGMENT_NORMAL_|SURFACE_AIRBRUSH_VIEW_DISTANCE_|SURFACE_AIRBRUSH_VIEW_DEPTH_/);
  assert.doesNotMatch(body, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(hasViewGate\.select\(viewCoverage, float\(1\)\)\)/);
  assert.match(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthGate\)[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(bridgePermission\)/);
  assert.doesNotMatch(body, /const surfaceCoverage = surfaceFieldCoverage[\s\S]*?viewDistancePermission/);
  assert.doesNotMatch(body, /\.mul\(viewDistancePermission\)[\s\S]*?\.mul\(depthPermission\)[\s\S]*?\.mul\(visibleCoverage\)/);
  assert.doesNotMatch(body, /sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(visibleCoverage\)/);
  assert.match(body, /\.mul\(normalGate\)/);
  assert.doesNotMatch(body, /\.mul\(strokeNormalGate\)/);
  assert.doesNotMatch(body, /const continuousSurfaceCoverage = min/);
  assert.doesNotMatch(body, /const softViewCoverage/);
  assert.doesNotMatch(body, /const softDepthCoverage/);
});

test("TSL surface airbrush accepts screen-only live drag segments", () => {
  const body = functionSource("normalizeSurfaceSegments");
  assert.match(body, /const hasViewSegment = Boolean/);
  assert.doesNotMatch(body, /if \(!worldStart \|\| !worldEnd \|\| viewRadius <= 0\)/);
  assert.match(body, /start,\s*\n\s*end,\s*\n\s*radius,/);
});

test("TSL source-raster normals are skinned before normal gating", () => {
  const normalBody = sourceFunction(projectionRecordSource, "viewNormalForVertex");
  const skinBody = sourceFunction(projectionRecordSource, "skinLocalNormalForVertex");
  assert.match(normalBody, /skinLocalNormalForVertex\(object, geometry, vertexIndex, _normal\)/);
  assert.match(skinBody, /geometry\?\.attributes\?\.skinIndex/);
  assert.match(skinBody, /geometry\?\.attributes\?\.skinWeight/);
  assert.match(skinBody, /skeleton\.getBoneMatrix\(boneIndex, _boneMatrix\)/);
  assert.match(skinBody, /_skinMatrix\.multiplyMatrices\(object\.bindMatrixInverse, _skinMatrix\)\.multiply\(object\.bindMatrix\)/);
  assert.match(skinBody, /_normal4\.set\(normal\.x, normal\.y, normal\.z, 0\)\.applyMatrix4\(_skinMatrix\)/);
});

test("surface projection records keep UV and screen coordinates in one contract", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0.25, 0.75], 2));
  const object = new THREE.Mesh(geometry);
  object.updateMatrixWorld(true);
  const camera = {
    isPerspectiveCamera: false,
    matrixWorldInverse: new THREE.Matrix4(),
    projectionMatrix: new THREE.Matrix4(),
    updateMatrixWorld() {}
  };
  const editor = {
    camera,
    canvas: {
      getBoundingClientRect() {
        return { width: 200, height: 100 };
      }
    }
  };

  const record = surfaceProjectionRecord(editor, object, geometry, 0, 2);

  assert.equal(record.valid, true);
  assert.deepEqual(record.uv, { x: 0.25, y: 0.75 });
  assert.deepEqual(record.screen, { x: 100, y: 50, z: 0 });
  assert.deepEqual(record.view, { x: 0, y: 0, z: 0 });
  assert.equal(record.componentId, 2);
  assert.equal(record.componentAttribute, 3);
});

test("surface brush colors enter TSL materials in linear working space", () => {
  const working = surfaceBrushWorkingColor({ r: 192, g: 111, b: 79 });
  assert.ok(Math.abs(working.r - 0.527115) < 0.00001);
  assert.ok(Math.abs(working.g - 0.158961) < 0.00001);
  assert.ok(Math.abs(working.b - 0.078187) < 0.00001);

  const uniform = { set(...values) { this.values = values; } };
  assert.equal(setSurfaceBrushColorUniform(uniform, { r: 255, g: 0, b: 0 }), true);
  assert.deepEqual(uniform.values, [1, 0, 0, 1]);
});

test("surface stroke-mask sizing preserves aspect ratio under its GPU cap", () => {
  assert.equal(SURFACE_STROKE_MASK_MAX_SIZE, 2048);
  assert.deepEqual(surfaceStrokeMaskSize(4096, 4096), {
    width: 2048,
    height: 2048,
    sourceWidth: 4096,
    sourceHeight: 4096,
    maxSize: 2048
  });
  assert.deepEqual(surfaceStrokeMaskSize(4096, 2048, 2048), {
    width: 2048,
    height: 1024,
    sourceWidth: 4096,
    sourceHeight: 2048,
    maxSize: 2048
  });
});

test("TSL layer paint accumulates between stroke-start bases while preserving source-over color mixing", () => {
  const body = functionSource("surfaceLayerPaintColor");
  assert.match(body, /const compositedLayerAlpha = clamp\(/);
  assert.match(body, /alpha\.add\(baseColor\.a\.mul\(oneMinusAlpha\)\)/);
  assert.match(body, /\.add\(baseLayerPremul\.mul\(oneMinusAlpha\)\)/);
  assert.doesNotMatch(body, /max\(baseColor\.a, alpha\)/);
  assert.match(body, /const layerOutAlpha = emptyLayer\.select\(alpha, compositedLayerAlpha\)\.toVar\(\)/);
  assert.match(body, /layerOutRgb\.mul\(layerOutAlpha\)/);
});

test("TSL layer erase removes premultiplied color and alpha from the stroke-start layer", () => {
  const body = functionSource("surfaceLayerEraseColor");
  assert.match(body, /const remaining = float\(1\)\.sub\(alpha\)\.toVar\(\)/);
  assert.match(body, /options\.basePremultiplied === true[\s\S]*?baseColor\.rgb[\s\S]*?: baseColor\.rgb\.mul\(baseColor\.a\)/);
  assert.match(body, /const erasedLayerAlpha = baseColor\.a\.mul\(remaining\)\.toVar\(\)/);
  assert.match(body, /const erasedLayerPremul = baseLayerPremul\.mul\(remaining\)\.toVar\(\)/);
});

test("both UV raster paths share the surface projection record", () => {
  const sourceRasterBody = functionSource("sourceUvRasterTriangles");
  const projectedRasterBody = functionSource("meshUvProjectedTriangles");

  assert.match(sourceRasterBody, /const projectionRecords = Array\.isArray\(options\.sourceRasterProjectionRecords\)/);
  assert.match(sourceRasterBody, /: new Array\(projectionRecordCount\)/);
  assert.match(projectedRasterBody, /const projectionRecords = new Array/);
  for (const body of [sourceRasterBody, projectedRasterBody]) {
    assert.match(body, /surfaceProjectionRecord\(/);
    assert.match(body, /return projectionRecords\[vertexIndex\]/);
  }
});

test("TSL live projected field preserves hit normals for same-side surface gating", () => {
  const compactBody = strokeSource.slice(
    strokeSource.indexOf("function compactHitSample"),
    strokeSource.indexOf("\nfunction cachedHitSample")
  );
  const liveCompactScreenBody = liveSource.slice(
    liveSource.indexOf("function compactScreenProjectedStrokeSegment"),
    liveSource.indexOf("\nfunction screenProjectedStrokeSegmentKey")
  );
  const liveCompactStrokeBody = liveSource.slice(
    liveSource.indexOf("function compactStrokeSegment"),
    liveSource.indexOf("\nfunction screenProjectedSegmentsForTextureSegments")
  );
  assert.match(strokeSource, /viewNormalStart: \{ x: options\.viewNormalStart\.x, y: options\.viewNormalStart\.y, z: options\.viewNormalStart\.z \}/);
  assert.match(strokeSource, /const startNormal = viewNormalFromHit\(editor, startHit\.hit\)/);
  assert.match(strokeSource, /viewNormalStart: startSample\.normal/);
  assert.match(strokeSource, /viewNormalEnd: endSample\.normal/);
  assert.match(compactBody, /const normal = Number\.isFinite\(sample\?\.normal\?\.x\)/);
  assert.match(compactBody, /\.\.\.\(normal \? \{ normal \} : \{\}\)/);
  assert.match(compactBody, /const component = Math\.floor\(Number\(sample\?\.component\)\)/);
  assert.match(compactBody, /\.\.\.\(Number\.isInteger\(component\) && component >= 0 \? \{ component \} : \{\}\)/);
  assert.match(liveCompactScreenBody, /const viewNormalStart = finiteViewPoint\(segment\?\.viewNormalStart \|\| segment\?\.normalStart\)/);
  assert.match(liveCompactScreenBody, /const componentStart = Math\.floor\(Number\(segment\?\.componentStart\)\)/);
  assert.match(liveCompactScreenBody, /\.\.\.\(Number\.isInteger\(componentStart\) && componentStart >= 0 \? \{ componentStart \} : \{\}\)/);
  assert.match(liveCompactStrokeBody, /const viewNormalEnd = finiteViewPoint\(segment\?\.viewNormalEnd \|\| segment\?\.normalEnd\)/);
  assert.match(liveCompactStrokeBody, /const componentEnd = Math\.floor\(Number\(segment\?\.componentEnd\)\)/);
  assert.match(liveCompactStrokeBody, /\.\.\.\(Number\.isInteger\(componentEnd\) && componentEnd >= 0 \? \{ componentEnd \} : \{\}\)/);
  assert.match(strokeSource, /rememberAnchor\([\s\S]*?segment\?\.start[\s\S]*?segment\?\.viewStart[\s\S]*?segment\?\.viewNormalStart[\s\S]*?segment\?\.componentStart[\s\S]*?\)/);
  assert.match(strokeSource, /rememberAnchor\([\s\S]*?segment\?\.end[\s\S]*?segment\?\.viewEnd[\s\S]*?segment\?\.viewNormalEnd[\s\S]*?segment\?\.componentEnd[\s\S]*?\)/);
  assert.match(strokeSource, /viewNormalStart: startAnchor\.normal/);
  assert.match(strokeSource, /function[\s\S]*sameSurfaceEndpoint/);
  assert.match(strokeSource, /const neighborSurfacePaintActive = options\.neighborPaintSeed\?\.enabled === true[\s\S]*?\|\| options\.largeLiveNeighborPaint === true/);
  assert.match(neighborSource, /const componentState = this\.textureAirbrushNeighborComponentState\?\.\(record\) \|\| null/);
  assert.match(neighborSource, /componentId: Number\.isFinite\(componentId\) && componentId >= 0 \? componentId : -1/);
  assert.match(strokeSource, /const neighborComponentCanConstrainSurfaceField = Boolean\(/);
  assert.match(strokeSource, /options\.neighborPaintSeed\?\.component\?\.size/);
  assert.match(strokeSource, /const neighborSeedComponentId = \(\(\) => \{/);
  assert.match(strokeSource, /const componentId = Math\.floor\(Number\(options\.neighborPaintSeed\?\.componentId\)\)/);
  assert.match(strokeSource, /const neighborSourceRasterComponentIds = neighborSeedComponentId >= 0[\s\S]*?\? \[neighborSeedComponentId\][\s\S]*?: null/);
  assert.match(strokeSource, /const neighborComponentGateRelaxed = relaxNeighborComponentGate\(options\)/);
  assert.match(strokeSource, /Neighbor expands the set of sampled surface hits/);
  assert.match(strokeSource, /const neighborComponentCanGateSurfacePermission = false/);
  assert.doesNotMatch(strokeSource, /const neighborComponentCanGateSurfacePermission = neighborComponentCanConstrainSurfaceField[\s\S]*?&& neighborSeedComponentId >= 0/);
  assert.match(strokeSource, /const componentIdsCanConstrainSurfaceField = neighborComponentCanConstrainSurfaceField[\s\S]*?!neighborSurfacePaintActive/);
  assert.match(strokeSource, /options\.hardTextureAirbrushComponentGate === true[\s\S]*?preferTslFullSurfaceUvRaster/);
  assert.match(strokeSource, /const localComponentCanGateSurfacePermission = componentIdsCanConstrainSurfaceField[\s\S]*?!neighborSurfacePaintActive[\s\S]*?options\.liveProjectedPaint === true[\s\S]*?preferTslFullSurfaceUvRaster/);
  assert.match(strokeSource, /const hardTextureComponentCanGateSurfacePermission = componentIdsCanConstrainSurfaceField[\s\S]*?options\.hardTextureAirbrushComponentGate === true[\s\S]*?!preferTslFullSurfaceUvRaster[\s\S]*?!neighborComponentGateRelaxed/);
  assert.match(strokeSource, /const componentIdsCanGateSurfaceField = localComponentCanGateSurfacePermission[\s\S]*?\|\| hardTextureComponentCanGateSurfacePermission/);
  assert.match(strokeSource, /const componentGateCanRelaxOnFrontmost = false/);
  assert.match(strokeSource, /const componentIdsSplitSurfaceSegments = componentIdsCanGateSurfaceField/);
  assert.match(strokeSource, /const sameSurfaceComponent = \(leftComponent = -1, rightComponent = -1\) =>/);
  assert.match(strokeSource, /if \(!componentIdsSplitSurfaceSegments\) \{[\s\S]*?return true/);
  assert.match(strokeSource, /const bridgeOnSameSurface = \(previous = null, segment = null\) =>/);
  assert.match(strokeSource, /!sameSurfaceComponent\([\s\S]*?previous\.componentEnd \?\? previous\.componentStart[\s\S]*?segment\.componentStart \?\? segment\.componentEnd[\s\S]*?\)/);
  assert.match(strokeSource, /const segmentCrossesComponents = componentIdsSplitSurfaceSegments[\s\S]*?segmentComponentStart !== segmentComponentEnd/);
  assert.match(strokeSource, /const surfaceSegment = segmentCrossesComponents[\s\S]*?componentEnd: segmentComponentStart/);
  assert.match(strokeSource, /&& bridgeOnSameSurface\(previous, surfaceSegment\)/);
  assert.match(strokeSource, /const crossesComponents = componentIdsSplitSurfaceSegments[\s\S]*?!sameSurfaceComponent\(startAnchor\.component, endAnchor\.component\)/);
  assert.match(strokeSource, /const remoteViewEnd = crossesComponents \|\| !sameSurfaceEndpoint/);
  assert.match(strokeSource, /const degenerateViewSegment = screenGap > Math\.max\(2, radius \* 0\.08\)[\s\S]*?viewGap <= Math\.max\(0\.0001, radiusWorld \* 0\.015\)/);
  assert.match(strokeSource, /const anchoredSegments = \[\]/);
  assert.match(strokeSource, /const pushAnchoredPointSegment = \(segment = null, point = null, anchor = null/);
  assert.match(strokeSource, /viewStart: anchor\.view,[\s\S]*?viewEnd: anchor\.view,[\s\S]*?viewRadiusPixels: resolvedRadiusWorld/);
  assert.match(strokeSource, /if \(remoteViewEnd\) \{[\s\S]*?pushAnchoredPointSegment\(segment, startPoint, startAnchor, radius, radiusWorld\);[\s\S]*?pushAnchoredPointSegment\(segment, endPoint, endAnchor, radius, radiusWorld\);[\s\S]*?continue;/);
  assert.match(strokeSource, /const useDirectionalViewSegment = !degenerateViewSegment/);
  assert.match(strokeSource, /const safeEndNormal = useDirectionalViewSegment[\s\S]*?\? endAnchor\.normal[\s\S]*?: null/);
  assert.match(strokeSource, /viewStart,[\s\S]*?viewEnd,[\s\S]*?viewRadiusPixels: radiusWorld/);
  assert.match(strokeSource, /useDirectionalViewSegment && startAnchor\.normal \? \{ viewNormalStart: startAnchor\.normal \} : \{\}/);
  assert.match(strokeSource, /viewNormalEnd: safeEndNormal/);
  assert.match(strokeSource, /const maxScreenDistance = Math\.max\(10, \(Number\(radiusPixelsForSegment\) \|\| screenRadiusPixels\) \* 1\.6\)/);
  assert.match(strokeSource, /return bestDistance <= maxScreenDistance \? best : null/);
  assert.doesNotMatch(strokeSource, /reusedAnchor[\s\S]*?return null/);
  assert.doesNotMatch(source, /previousComponent >= 0 && firstComponent >= 0 && previousComponent !== firstComponent[\s\S]*?return false/);
  assert.match(strokeSource, /const annotateSurfaceFieldComponents = \(segments = \[\]\) => \{[\s\S]*?componentIdsCanGateSurfaceField[\s\S]*?const fallbackComponent = Math\.floor\(Number\(currentComponent\)\)[\s\S]*?const resolvedFallbackComponent = neighborSeedComponentId >= 0[\s\S]*?const gatedComponentStart = hasStart[\s\S]*?const gatedComponentEnd = hasEnd[\s\S]*?componentStart: gatedComponentStart[\s\S]*?componentEnd: gatedComponentEnd/);
  assert.doesNotMatch(strokeSource, /const gatedComponentStart = neighborComponentCanGateSurfacePermission[\s\S]*?\? resolvedFallbackComponent/);
  assert.doesNotMatch(strokeSource, /componentStart: neighborSeedComponentId,[\s\S]*?componentEnd: neighborSeedComponentId/);
  assert.match(strokeSource, /return anchoredSegments;[\s\S]*?const annotateSurfaceFieldComponents/);
  assert.match(strokeSource, /const continuousNeighborScreenFieldSegments = preferTslFullSurfaceUvRaster[\s\S]*?&& neighborSurfacePaintActive[\s\S]*?screenPaintStrokeSegments\.slice\(0, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS\)/);
  assert.match(strokeSource, /const projectedFieldStrokeSegments = annotateSurfaceFieldComponents\(continuousNeighborScreenFieldSegments\.length[\s\S]*?\? continuousNeighborScreenFieldSegments[\s\S]*?: surfaceEnrichedScreenPaintStrokeSegments\.length[\s\S]*?: projectedSurfaceBrushSegments\.length[\s\S]*?: screenPaintStrokeSegments\)/);
  assert.match(strokeSource, /const cameraFacingSurfaceFieldStrokeSegments = \(\(\) => \{/);
  assert.match(strokeSource, /const rejectZ = visibleEdgeMode === "hard" \? 0 : -0\.28/);
  assert.match(strokeSource, /return Math\.max\(startZ \?\? endZ, endZ \?\? startZ\) >= rejectZ/);
  assert.match(strokeSource, /screenProjectedStrokeSegments: outputProjectedFieldStrokeSegments/);
  assert.match(strokeSource, /viewNormalStart: previous\.viewNormalEnd \|\| previous\.viewNormalStart/);
  assert.match(strokeSource, /viewNormalEnd: surfaceSegment\.viewNormalStart \|\| surfaceSegment\.viewNormalEnd/);
  assert.match(strokeSource, /const shouldAddIndexedStrokeAnchors = options\.liveProjectedPaint === true[\s\S]*?&& preferTslFullSurfaceUvRaster[\s\S]*?&& screenPaintStrokeSegments\.length > 0/);
  assert.match(strokeSource, /const needsIndexedNormalAnchors = !anchors\.length[\s\S]*?\|\| !anchors\.some\(\(anchor\) => anchor\?\.normal\)[\s\S]*?\|\| shouldAddIndexedStrokeAnchors/);
  assert.match(strokeSource, /const canBuildIndexedNormalAnchors = Boolean\(editor\?\.camera\?\.matrixWorldInverse\)/);
  assert.match(strokeSource, /for \(const sample of \[strokeStartSample, currentSample\]\) \{/);
  assert.match(strokeSource, /screenPointFromClientPoint\(editor, sample\.client\)/);
  assert.match(strokeSource, /const indexedAnchorSegments = screenPaintStrokeSegments\.slice\(0, Math\.min\(screenPaintStrokeSegments\.length, 24\)\)/);
  assert.match(strokeSource, /needsIndexedNormalAnchors[\s\S]*?&& canBuildIndexedNormalAnchors[\s\S]*?&& typeof editor\?\.textureAirbrushScreenHitsForEvent === "function"/);
  assert.match(strokeSource, /raycastFallbackOnScreenMiss: true/);
  assert.match(strokeSource, /if \(indexed === undefined && typeof editor\.texturePaintHitForEvent === "function"\) \{[\s\S]*?indexed = editor\.texturePaintHitForEvent\(pointEvent, "airbrush"\)/);
  assert.match(strokeSource, /const sameDistance = Math\.abs\(distance - bestDistance\) <= 0\.001/);
  assert.match(strokeSource, /distance < bestDistance \|\| \(sameDistance && !best\?\.normal && anchor\?\.normal\)/);
  assert.match(strokeSource, /const useTslSourceMeshVisibilitySeed = skipProjectedSeamStrokeSegmentsForTslSurface/);
  assert.match(strokeSource, /const visibilityTriangleLimitForSurfaceSeed = useTslSourceMeshVisibilitySeed[\s\S]*?Math\.max\(32,[\s\S]*?Math\.min\([\s\S]*?512/);
  assert.match(strokeSource, /const screenBrushVisibilityTrianglesForSurfaceSeed = options\.screenBrushVisibilityTriangles/);
  assert.match(strokeSource, /screenBrushVisibilityTriangles: screenBrushVisibilityTrianglesForSurfaceSeed/);
  assert.match(strokeSource, /fullBrushVisibilityProbes: useTslSourceMeshVisibilitySeed \? false : options\.fullBrushVisibilityProbes/);
  assert.match(strokeSource, /\.\.\.\(componentIdsCanGateSurfaceField \? \{ hardTextureAirbrushComponentGate: true \} : \{\}\)/);
  assert.match(strokeSource, /\.\.\.\(componentGateCanRelaxOnFrontmost \? \{ relaxComponentGateOnFrontmost: true \} : \{\}\)/);
  assert.match(strokeSource, /\.\.\.\(neighborSourceRasterComponentIds \? \{ sourceRasterAllowedComponentIds: neighborSourceRasterComponentIds \} : \{\}\)/);
  for (const candidateSource of [strokeSource, liveSource, projectionSource]) {
    assert.match(candidateSource, /function compactVisibilityTriangle/);
    assert.match(candidateSource, /const componentId = Math\.floor\(Number\(triangle\?\.componentId\)\)/);
    assert.match(candidateSource, /\.\.\.\(Number\.isInteger\(componentId\) && componentId >= 0 \? \{ componentId \} : \{\}\)/);
  }
  assert.match(liveSource, /Number\.isInteger\(compact\.componentId\) \? compact\.componentId : -1/);
  assert.match(projectionSource, /Number\.isInteger\(triangle\.componentId\) \? triangle\.componentId : -1/);
});

test("TSL projected gutter interpolation uses standard area barycentrics", () => {
  const body = functionSource("barycentricForPoint");
  assert.match(body, /const u = triangleArea2\(point, b, c\) \/ denom/);
  assert.match(body, /const v = triangleArea2\(a, point, c\) \/ denom/);
  assert.match(body, /const w = triangleArea2\(a, b, point\) \/ denom/);
  assert.doesNotMatch(body, /point\.x - b\.x/);
  assert.doesNotMatch(body, /1 - u - v/);
});

test("TSL surface airbrush keeps brush falloff independent from hard visible-depth permissions", () => {
  const surfaceBody = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  assert.doesNotMatch(surfaceBody, /viewDistancePermission/);
  assert.doesNotMatch(surfaceBody, /depthSoftPermission/);
  assert.doesNotMatch(surfaceBody, /depthPermission/);
  assert.doesNotMatch(surfaceBody, /depthHardPermission/);
  assert.doesNotMatch(surfaceBody, /const screenOnlyCoverage = visibleActive\.greaterThan\(0\.5\)/);
  assert.match(surfaceBody, /const segmentViewEnds = uniformArray/);
  assert.doesNotMatch(surfaceBody, /const viewEnd = segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(surfaceBody, /const visibleDepthGate =/);
  assert.doesNotMatch(surfaceBody, /const viewRadius = max\(mix\(viewStart\.w, viewEnd\.w, viewT\), 0\.0001\)\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const viewDistancePixels/);
  assert.doesNotMatch(surfaceBody, /visibilityCoverage|visibleDepthFade|visibleDepthSmoothFade/);
  assert.doesNotMatch(surfaceBody, /visibleGateCoverage/);
  assert.doesNotMatch(surfaceBody, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(surfaceBody, /normalCompatibility|surfacePlanePermission/);
  assert.match(surfaceBody, /const screenCoverage = edgeCoverage\.toVar\(\)/);
  assert.match(surfaceBody, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const surfaceCoverage =/);
  assert.doesNotMatch(surfaceBody, /screenGate/);
  assert.doesNotMatch(surfaceBody, /surfaceCoverage\.mul\(screenGate\)/);
  assert.doesNotMatch(surfaceBody, /const viewCoverage = max\(0\.0, float\(1\)\.sub\(viewSmoothEdge\)\)\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /viewContinuityCoverage|viewContinuityFade|viewContinuitySmoothFade/);
  assert.match(surfaceBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(visibilityCoverage\)/);
  assert.doesNotMatch(surfaceBody, /const surfaceFieldCoverage = brushFieldCoverage\.mul\(depthGate\)/);
  assert.match(surfaceBody, /const frontmostSurfaceHardCoverage = visibleDepthDelta[\s\S]*?lessThanEqual\(VISIBLE_SURFACE_OCCLUSION_DEPTH_TOLERANCE\)[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const frontmostSurfaceSoftRamp = clamp\([\s\S]*?VISIBLE_SURFACE_OCCLUSION_DEPTH_SOFT_FEATHER[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const frontmostSurfaceCoverage = mix\([\s\S]*?frontmostSurfaceSoftCoverage,[\s\S]*?frontmostSurfaceHardCoverage,[\s\S]*?hardVisibleEdge[\s\S]*?\)\.toVar\(\)/);
  assert.match(surfaceBody, /const closerDepthRamp = clamp\([\s\S]*?visibleDepthDelta\.mul\(-1\)[\s\S]*?VISIBLE_SURFACE_CLOSER_DEPTH_TOLERANCE[\s\S]*?VISIBLE_SURFACE_CLOSER_DEPTH_FEATHER[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const visibleDepthCoverageBase = frontmostSurfaceCoverage\.mul\(closerDepthCoverage\)\.toVar\(\)/);
  assert.match(surfaceBody, /const visibleSoftEdgeCoverageForOffset = \(offset\) => max\([\s\S]*?visibleTextureNode\.sample[\s\S]*?vec2\(offset\.x, 0\)[\s\S]*?vec2\(0, offset\.y\)[\s\S]*?\);/);
  assert.match(surfaceBody, /const visibleSoftEdgeCoverage = max\([\s\S]*?VISIBLE_SURFACE_SOFT_EDGE_COVERAGE[\s\S]*?VISIBLE_SURFACE_SOFT_EDGE_FAR_COVERAGE[\s\S]*?float\(1\)\.sub\(hardVisibleEdge\)[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const visibleDepthCoverage = max\([\s\S]*?visibleDepthCoverageBase,[\s\S]*?visibleSoftEdgeCoverage\.mul\(visibleSampleValid\)[\s\S]*?\)\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const visibleDepthCoverage = max\(visibleDepthCoverageBase, visibleSoftEdgeCoverage\)\.toVar\(\)/);
  assert.match(surfaceBody, /const depthGate = mix\(float\(1\), visibleDepthCoverage, visibleActive\)\.toVar\(\)/);
  assert.match(surfaceBody, /const frontmostSurfaceLocalityAuthority = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?\.mul\(visibleDepthCoverageBase\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /depthGate = mix\(float\(1\), visibleDepthCoverage, visibleActive\.mul\(visibleSampleValid\)\)/);
  assert.doesNotMatch(surfaceBody, /frontmostSurfaceLocalityAuthority = visibleActive[\s\S]*?\.mul\(visibleDepthCoverage\)[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const segmentHasDirectionalView = segmentHasView[\s\S]*?segmentViewLengthRaw\.greaterThan\(0\.000001\)[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const segmentHasPointView = segmentHasView[\s\S]*?segmentViewLengthRaw\.lessThanEqual\(0\.000001\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /frontmostDistanceGate|frontmostDistanceRamp|frontmostDistanceLimit|frontmostDistanceFeather/);
  assert.match(surfaceBody, /const segmentDepthGate = segmentHasDirectionalView[\s\S]*?\.select\([\s\S]*?segmentDepthFeathered,[\s\S]*?segmentHasPointView\.select\(segmentDepthFeathered, float\(1\)\)[\s\S]*?\)[\s\S]*?\.toVar\(\)/);
  assert.match(surfaceBody, /const strictSegmentLocalityGate = opposedNormalGate[\s\S]*?\.mul\(segmentDistanceGate\)[\s\S]*?\.mul\(segmentDepthGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /frontmostSegmentLocalityGate/);
  assert.match(surfaceBody, /const segmentLocalityGate = mix\([\s\S]*?strictSegmentLocalityGate,[\s\S]*?float\(1\),[\s\S]*?frontmostSurfaceLocalityAuthority[\s\S]*?\)\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(hasViewGate\.select\(viewCoverage, float\(1\)\)\)/);
  assert.match(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthGate\)[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /visibleCoverage|visiblePermission|visibleSoftPermission|visibleGateCoverage/);
  assert.doesNotMatch(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentPermission\)/);
  assert.doesNotMatch(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(bridgePermission\)/);
  assert.doesNotMatch(surfaceBody, /\.mul\(viewDistancePermission\)[\s\S]*?\.mul\(depthPermission\)[\s\S]*?\.mul\(visibleCoverage\)/);
  assert.doesNotMatch(surfaceBody, /mix\(viewCoverage, float\(1\)/);
  assert.match(projectedBody, /gatedCoverage/);
  assert.match(projectedBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.match(projectedBody, /const frontmostSurfaceLocalityAuthority = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?\.mul\(visibleDepthCoverageBase\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /frontmostSurfaceLocalityAuthority = visibleActive[\s\S]*?\.mul\(visibleDepthCoverage\)[\s\S]*?\.toVar\(\)/);
  assert.match(projectedBody, /const segmentHasDirectionalView = segmentHasView[\s\S]*?segmentViewLengthRaw\.greaterThan\(0\.000001\)[\s\S]*?\.toVar\(\)/);
  assert.match(projectedBody, /const segmentHasPointView = segmentHasView[\s\S]*?segmentViewLengthRaw\.lessThanEqual\(0\.000001\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /frontmostDistanceGate|frontmostDistanceRamp|frontmostDistanceLimit|frontmostDistanceFeather/);
  assert.match(projectedBody, /const segmentDepthGate = segmentHasDirectionalView[\s\S]*?\.select\([\s\S]*?segmentDepthFeathered,[\s\S]*?segmentHasPointView\.select\(segmentDepthFeathered, float\(1\)\)[\s\S]*?\)[\s\S]*?\.toVar\(\)/);
  assert.match(projectedBody, /const strictSegmentLocalityGate = opposedNormalGate[\s\S]*?\.mul\(segmentDistanceGate\)[\s\S]*?\.mul\(segmentDepthGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /frontmostSegmentLocalityGate/);
  assert.match(projectedBody, /const segmentLocalityGate = mix\([\s\S]*?strictSegmentLocalityGate,[\s\S]*?float\(1\),[\s\S]*?frontmostSurfaceLocalityAuthority[\s\S]*?\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(visibilityCoverage\)/);
  assert.doesNotMatch(projectedBody, /const surfaceFieldCoverage = brushFieldCoverage\.mul\(depthGate\)/);
  assert.doesNotMatch(projectedBody, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(hasViewGate\.select\(viewCoverage, float\(1\)\)\)/);
  assert.doesNotMatch(projectedBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentPermission\)/);
  assert.doesNotMatch(projectedBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(bridgePermission\)/);
  assert.match(projectedBody, /const sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(depthGate\)[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(visibleCoverage\)/);
  assert.doesNotMatch(projectedBody, /const sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(projectedBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?viewDistancePermission/);
  assert.match(projectedBody, /coverage\.assign\(max\(coverage, sampleCoverage\)\)/);
  assert.match(projectedBody, /const noCoverage = alpha\.lessThanEqual\(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD\)\.toVar\(\)/);
  assert.match(projectedBody, /gutterOnly[\s\S]*?\.select\(insideOriginalTriangle\.or\(noCoverage\), noCoverage\)/);
  assert.match(projectedBody, /discardFragment\.discard\(\)/);
  assert.doesNotMatch(projectedBody, /const screenOnlyCoverage = visibleActive\.greaterThan\(0\.5\)/);
  assert.match(projectedBody, /const segmentViewEnds = uniformArray/);
  assert.doesNotMatch(projectedBody, /const viewEnd = segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(projectedBody, /const visibleDepthGate =/);
  assert.doesNotMatch(projectedBody, /const viewRadius = max\(mix\(viewStart\.w, viewEnd\.w, viewT\), 0\.0001\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const viewDistancePixels/);
  assert.doesNotMatch(projectedBody, /visibilityCoverage|visibleDepthFade|visibleDepthSmoothFade/);
  assert.doesNotMatch(projectedBody, /visibleGateCoverage/);
  assert.doesNotMatch(projectedBody, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(projectedBody, /normalCompatibility|surfacePlanePermission/);
  assert.match(projectedBody, /const screenCoverage = edgeCoverage\.toVar\(\)/);
  assert.match(projectedBody, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const surfaceCoverage =/);
  assert.doesNotMatch(projectedBody, /screenGate/);
  assert.doesNotMatch(projectedBody, /surfaceCoverage\.mul\(screenGate\)/);
  assert.doesNotMatch(projectedBody, /viewRadiusRaw\.greaterThan\(0\.0001\)[\s\S]*?\.select\(mix\(viewCoverage/);
  assert.doesNotMatch(projectedBody, /screenCoverage\.mul\(surfaceGate\)/);
});

test("TSL surface airbrush evaluates coverage from fragment-projected surface points", () => {
  const body = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  const sourceVertexBody = functionSource("addSourceRasterVertex");
  assert.match(body, /paintView\.assign\(attribute\("paintView", "vec3"\)\)/);
  assert.match(body, /paintScreen\.assign\(attribute\("paintScreen", "vec3"\)\)/);
  assert.match(body, /const projectedClip = editorProjectionMatrix\.mul\(vec4\(editorView, 1\)\)\.toVar\(\)/);
  assert.match(projectedBody, /const projectedClip = editorProjectionMatrix\.mul\(vec4\(editorView, 1\)\)\.toVar\(\)/);
  assert.match(body, /const projectedNdc = projectedClip\.xyz\.div\(projectedW\)\.toVar\(\)/);
  assert.match(projectedBody, /const projectedNdc = projectedClip\.xyz\.div\(projectedW\)\.toVar\(\)/);
  assert.match(body, /const surfaceScreen = vec3\([\s\S]*?editorViewportSize\.x[\s\S]*?editorViewportSize\.y[\s\S]*?paintScreen\.z[\s\S]*?\)\.toVar\(\)/);
  assert.match(projectedBody, /const surfaceScreen = vec3\([\s\S]*?editorViewportSize\.x[\s\S]*?editorViewportSize\.y[\s\S]*?paintScreen\.z[\s\S]*?\)\.toVar\(\)/);
  assert.match(projectionRecordSource, /function ensureSurfaceProjectionAttributes/);
  assert.match(projectionRecordSource, /screenPointForWorld\(editor, world\)/);
  assert.match(source, /function textureNodeAppliesFlipY/);
  assert.match(sourceVertexBody, /textureNodeAppliesFlipY\(referenceTexture\) \? 1 - sampleV : sampleV/);
  assert.ok(
    body.indexOf('paintScreen.assign(attribute("paintScreen", "vec3"))') <
      body.indexOf("return vec4(positionLocal.x"),
    "surface screen position must be captured before the vertex is moved into UV space"
  );
});

test("TSL surface airbrush freezes every live stroke-start base", () => {
  const body = functionSource("copySurfaceBaseTexture");
  const directBaseBody = functionSource("surfaceStrokeStartBaseTexture");
  const strokeBaseBody = functionSource("ensureSurfaceStrokeBaseTexture");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  const copyMaterialBody = functionSource("createTextureCopyMaterial");
  const textureSettingsBody = functionSource("copyTextureSettings");
  assert.match(body, /typeof renderer\.copyTextureToTexture !== "function"/);
  assert.doesNotMatch(body, /const safeLiveTargetCopy = Boolean\(/);
  assert.match(body, /debugAirbrushNativeCopy/);
  assert.match(body, /texturePaintTslSurfaceLastBaseCopyError = "missing-copyTextureToTexture"/);
  assert.match(body, /texturePaintTslSurfaceLastBaseCopyError = "native-copy-disabled"/);
  assert.match(body, /const sourceNeedsFlip = textureNodeAppliesFlipY\(sourceTexture\)/);
  assert.match(body, /const targetNeedsFlip = textureNodeAppliesFlipY\(target\.texture\)/);
  assert.match(body, /texturePaintTslSurfaceLastBaseCopyError = "copy-needs-flip"/);
  assert.match(body, /textureLikeSize\(sourceTexture\)/);
  assert.match(body, /renderer\.copyTextureToTexture\(sourceTexture, target\.texture\)/);
  assert.match(body, /return false/);
  assert.match(directBaseBody, /function surfaceStrokeStartBaseTexture/);
  assert.match(directBaseBody, /surfaceAirbrushTextureIsLiveTarget\(sourceTexture\)/);
  assert.match(directBaseBody, /!surfaceAirbrushCacheOwnsTexture\(cache, sourceTexture\)/);
  assert.match(directBaseBody, /surfaceAirbrushStableTextureFromLiveTarget\(sourceTexture\) \|\| sourceTexture/);
  assert.match(directBaseBody, /return sourceTexture/);
  assert.match(runBody, /const freezeLiveStrokeBase = Boolean\([\s\S]*?layerMode[\s\S]*?surfaceAirbrushTextureIsLiveTarget\(sourceTexture\)[\s\S]*?surfaceAirbrushCacheOwnsTexture\(cache, sourceTexture\)/);
  assert.match(runBody, /cache\.strokeBaseTexture = freezeLiveStrokeBase[\s\S]*?\? ensureSurfaceStrokeBaseTexture\([\s\S]*?renderer,[\s\S]*?cache,[\s\S]*?sourceTexture,[\s\S]*?coordinateReferenceTexture \|\| referenceTexture \|\| sourceTexture,[\s\S]*?width,[\s\S]*?height[\s\S]*?\)[\s\S]*?: surfaceStrokeStartBaseTexture\(cache, sourceTexture\)/);
  assert.match(runBody, /texturePaintTslSurfaceLastStrokeBaseCopy = cache\.strokeBaseTexture === sourceTexture[\s\S]*?\? "direct-source"[\s\S]*?: "stable-source"/);
  assert.doesNotMatch(runBody, /cachePingPongStrokeBase/);
  assert.doesNotMatch(runBody, /"cache-ping-pong"/);
  assert.match(strokeBaseBody, /cache\.strokeBaseTarget = createRenderTarget/);
  assert.match(strokeBaseBody, /surfaceAirbrushTextureIsLiveTarget\(sourceTexture\)/);
  assert.match(strokeBaseBody, /surfaceAirbrushStableTextureFromLiveTarget\(sourceTexture\)/);
  assert.match(strokeBaseBody, /copySurfaceBaseTexture\(renderer, sourceTexture, cache\.strokeBaseTarget, cache\)/);
  assert.match(strokeBaseBody, /texturePaintTslSurfaceLastStrokeBaseCopy = copiedBaseTexture \? "gpu-copy" : "shader-copy"/);
  assert.doesNotMatch(strokeBaseBody, /direct-paint-target/);
  assert.match(textureSettingsBody, /targetTexture\.colorSpace = referenceTexture\.colorSpace/);
  assert.match(textureSettingsBody, /targetTexture\.flipY = false/);
  assert.match(textureSettingsBody, /texturePaintTslSurfaceDisplayFlipY = referenceTexture\.flipY === true/);
  assert.match(copyMaterialBody, /new THREE\.MeshBasicMaterial/);
  assert.match(copyMaterialBody, /map: sourceTexture \|\| null/);
  assert.match(copyMaterialBody, /blending: THREE\.NoBlending/);
  assert.match(copyMaterialBody, /texturePaintTslSurfaceCopy/);
  assert.match(copyMaterialBody, /const sourceFlipY = uniform\(0, "float"\)/);
  assert.match(copyMaterialBody, /const sampleUv = vec2\([\s\S]*?mix\(currentUv\.y, float\(1\)\.sub\(currentUv\.y\), sourceFlipY\)/);
  assert.match(copyMaterialBody, /sourceTextureNode\.sample\(sampleUv\)/);
});

test("TSL surface airbrush feathers normal cutoff for soft strokes and hard-cuts hard strokes", () => {
  const body = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  const updateBody = functionSource("updateSurfaceMaterial");
  assert.match(body, /hardVisibleEdge/);
  assert.match(body, /visibleNormalEdge/);
  assert.match(source, /const SOFT_FACING_NORMAL_BACK_FEATHER = 0\.28/);
  assert.match(source, /const SOFT_FACING_NORMAL_FRONT_FEATHER = 0\.16/);
  assert.match(source, /const VISIBLE_SURFACE_NORMAL_RESCUE_MIN_LOCAL_Z = -0\.02/);
  assert.doesNotMatch(source, /SURFACE_NORMAL_COMPATIBILITY_MIN/);
  assert.doesNotMatch(source, /SURFACE_NORMAL_COMPATIBILITY_FULL/);
  assert.match(source, /const VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS = 0\.18/);
  assert.doesNotMatch(source, /VISIBLE_SURFACE_DEPTH_GATE_/);
  assert.doesNotMatch(body, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.doesNotMatch(body, /strokeFacingSign/);
  assert.doesNotMatch(body, /mix\(float\(1\), strokeFacingSign, normalPresence\)/);
  assert.match(body, /const currentFacingNormalZ = editorNormalLength\.greaterThan\(0\.0002\)/);
  assert.doesNotMatch(source, /VISIBLE_NORMAL_RESCUE_DEPTH_TOLERANCE/);
  assert.match(body, /const visibleFacingSampleZ = visibleSample\.g\.mul\(2\.0\)\.sub\(1\.0\)\.toVar\(\)/);
  assert.match(body, /const visibleNormalRescue = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?currentFacingNormalZ\.greaterThanEqual\(VISIBLE_SURFACE_NORMAL_RESCUE_MIN_LOCAL_Z\)[\s\S]*?visibleDelta\.lessThanEqual\(VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS\)/);
  assert.match(body, /mix\(\s*currentFacingNormalZ,\s*visibleFacingSampleZ,\s*visibleNormalRescue\s*\)/);
  assert.doesNotMatch(body, /max\(currentFacingNormalZ, visibleFacingSampleZ\)/);
  assert.match(body, /const softFacingRamp = clamp\([\s\S]*?facingNormalZ\.add\(SOFT_FACING_NORMAL_BACK_FEATHER\)[\s\S]*?SOFT_FACING_NORMAL_FRONT_FEATHER[\s\S]*?\)\.toVar\(\)/);
  assert.match(body, /const softFacingCoverage = softFacingRamp[\s\S]*?\.mul\(softFacingRamp\)[\s\S]*?float\(3\)\.sub\(softFacingRamp\.mul\(2\)\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /pow\(softFacingRamp, SOFT_FACING_NORMAL_POWER\)/);
  assert.doesNotMatch(body, /softFacingCoverage = facingNormalZ\.greaterThanEqual\(0\.0\)[\s\S]*?select\(float\(1\)/);
  assert.match(body, /const hardFacingCoverage = facingNormalZ\.greaterThanEqual\(0\.0\)\.select\(float\(1\), float\(0\)\)\.toVar\(\)/);
  assert.match(body, /const facingCoverage = mix\(softFacingCoverage, hardFacingCoverage, hardVisibleEdge\)\.toVar\(\)/);
  assert.match(body, /const normalGate = mix\(float\(1\), facingCoverage, visibleNormalEdge\)\.toVar\(\)/);
  assert.match(body, /\.mul\(normalGate\)/);
  assert.doesNotMatch(body, /\.mul\(strokeNormalGate\)/);
  assert.match(projectedBody, /const visibleFacingSampleZ = visibleSample\.g\.mul\(2\.0\)\.sub\(1\.0\)\.toVar\(\)/);
  assert.match(projectedBody, /const visibleNormalRescue = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?currentFacingNormalZ\.greaterThanEqual\(VISIBLE_SURFACE_NORMAL_RESCUE_MIN_LOCAL_Z\)[\s\S]*?visibleDelta\.lessThanEqual\(VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS\)/);
  assert.doesNotMatch(body, /visibilityCoverage|visibleDepthFade|visibleDepthSmoothFade/);
  assert.doesNotMatch(projectedBody, /visibilityCoverage|visibleDepthFade|visibleDepthSmoothFade/);
  assert.doesNotMatch(body, /visibleGateCoverage/);
  assert.doesNotMatch(projectedBody, /visibleGateCoverage/);
  assert.doesNotMatch(body, /visibleBehindDepth|visibleDepthGate/);
  assert.doesNotMatch(projectedBody, /visibleBehindDepth|visibleDepthGate/);
  assert.doesNotMatch(body, /visibleRadius|visibleFeatherRadius/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.85\)/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.9\)/);
  assert.doesNotMatch(body, /visiblePermission|visibleSoftPermission|visibleHardPermission/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.18\)\.add\(softness\.mul\(0\.12\)\.add\(scatter\.mul\(0\.05\)\)\)/);
  assert.doesNotMatch(projectedBody, /max\(currentFacingNormalZ, visibleFacingSampleZ\)/);
  assert.match(projectedBody, /const facingCoverage = mix\(softFacingCoverage, hardFacingCoverage, hardVisibleEdge\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.match(projectedBody, /\.mul\(normalGate\)/);
  assert.doesNotMatch(projectedBody, /\.mul\(strokeNormalGate\)/);
  assert.match(body, /const visibleUvRaw = clamp\(surfaceScreen\.xy\.div\(editorViewportSize\), vec2\(0\), vec2\(1\)\)\.toVar\(\)/);
  assert.match(body, /const visibleInViewport = surfaceScreen\.x\.greaterThanEqual\(0\)[\s\S]*?surfaceScreen\.x\.lessThanEqual\(editorViewportSize\.x\)[\s\S]*?surfaceScreen\.y\.greaterThanEqual\(0\)[\s\S]*?surfaceScreen\.y\.lessThanEqual\(editorViewportSize\.y\)[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const visibleSampleValid = clamp\(visibleSample\.a\.mul\(32\.0\), 0\.0, 1\.0\)[\s\S]*?\.mul\(visibleInViewport\.select\(float\(1\), float\(0\)\)\)[\s\S]*?\.toVar\(\)/);
  assert.match(body, /const visibleUv = vec2\(visibleUvRaw\.x, float\(1\)\.sub\(visibleUvRaw\.y\)\)\.toVar\(\)/);
  assert.match(projectedBody, /const visibleUv = vec2\(visibleUvRaw\.x, float\(1\)\.sub\(visibleUvRaw\.y\)\)\.toVar\(\)/);
  assert.doesNotMatch(body, /normalPresence\.mul\(hardness\)\.mul\(0\.35\)/);
  assert.match(updateBody, /visibleEdgeMode/);
  assert.match(updateBody, /String\(options\.visibleEdgeMode \|\| "soft"\)\.toLowerCase\(\)/);
  assert.match(updateBody, /state\.visibleSurfaceEnabled\.value = options\.debugVisibleSurfaceDepth === true && visibleTexture \? 1 : 0/);
  assert.match(updateBody, /state\.hardVisibleEdge\.value = visibleEdgeMode === "hard" \? 1 : 0/);
  assert.match(updateBody, /debugAirbrushNoNormalGate/);
  assert.match(updateBody, /state\.visibleNormalEdge\.value = debugParams\?\.has\("debugAirbrushNoNormalGate"\) === true[\s\S]*?\? 0[\s\S]*?: visibleEdgeMode === "hard" \|\| visibleEdgeMode === "soft" \? 1 : 0/);
});

test("Neighbor surface paint clips the brush footprint to the raycast-visible hemisphere", () => {
  const gateBody = functionSource("surfaceSegmentVisibleHemisphereGate");
  const body = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  assert.match(gateBody, /const segmentFacingSign = opposedNormal\.z\.greaterThanEqual\(0\.0\)[\s\S]*?\.select\(float\(1\), float\(-1\)\)[\s\S]*?\.toVar\(\)/);
  assert.match(gateBody, /const segmentFacingNormalZ = editorNormalLength\.greaterThan\(0\.0002\)[\s\S]*?editorNormal\.z\.mul\(segmentFacingSign\)[\s\S]*?float\(1\)[\s\S]*?\.toVar\(\)/);
  assert.match(gateBody, /const segmentSoftFacingRamp = clamp\([\s\S]*?segmentFacingNormalZ\.div\(SOFT_FACING_NORMAL_FRONT_FEATHER\)[\s\S]*?0\.0[\s\S]*?1\.0[\s\S]*?\)\.toVar\(\)/);
  assert.match(gateBody, /const segmentFacingCoverage = mix\([\s\S]*?segmentSoftFacingCoverage[\s\S]*?segmentHardFacingCoverage[\s\S]*?hardVisibleEdge[\s\S]*?\)\.toVar\(\)/);
  assert.match(gateBody, /return componentGateEnabled[\s\S]*?\.greaterThan\(0\.5\)[\s\S]*?\.and\(opposedNormalAvailable\)[\s\S]*?\.select\(segmentFacingCoverage, float\(1\)\)[\s\S]*?\.toVar\(\)/);
  for (const materialBody of [body, projectedBody]) {
    assert.match(materialBody, /const segmentVisibleHemisphereGate = surfaceSegmentVisibleHemisphereGate\(tsl, \{[\s\S]*?componentGateEnabled[\s\S]*?opposedNormalAvailable[\s\S]*?\}\)/);
    assert.match(materialBody, /\.mul\(segmentVisibleHemisphereGate\)/);
  }
});

test("TSL visible-surface depth and normal buffer uses unblended texels", () => {
  const body = functionSource("createVisibleSurfaceTarget");
  assert.match(body, /target\.texture\.minFilter = THREE\.NearestFilter/);
  assert.match(body, /target\.texture\.magFilter = THREE\.NearestFilter/);
  assert.doesNotMatch(body, /target\.texture\.minFilter = THREE\.LinearFilter/);
  assert.doesNotMatch(body, /target\.texture\.magFilter = THREE\.LinearFilter/);
});

test("TSL surface airbrush uses the shared airbrush falloff constants", () => {
  const body = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  for (const token of [
    "TEXTURE_AIRBRUSH_CORE_MIN_SCALE",
    "TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER",
    "TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE",
    "TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE",
    "TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER",
    "TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE",
    "TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE",
    "TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD"
  ]) {
    assert.match(body, new RegExp(token));
    assert.match(projectedBody, new RegExp(token));
  }
  assert.doesNotMatch(source, /TEXTURE_AIRBRUSH_SCATTER_OUTER_RADIUS_SCALE/);
  assert.match(body, /const haloRadius = radius\.toVar\(\)/);
  assert.match(projectedBody, /const haloRadius = radius\.toVar\(\)/);
  assert.doesNotMatch(body, /scatter\.mul\(TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE\)/);
  assert.doesNotMatch(projectedBody, /scatter\.mul\(TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE\)/);
  assert.doesNotMatch(body, /SCATTER_OUTER_RADIUS_SCALE/);
  assert.doesNotMatch(projectedBody, /SCATTER_OUTER_RADIUS_SCALE/);
  assert.doesNotMatch(body, /const softness = float\(1\)\.sub\(hardness\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const softness = float\(1\)\.sub\(hardness\)\.toVar\(\)/);
  assert.doesNotMatch(body, /softness\.mul\(TEXTURE_AIRBRUSH_SOFT_HALO_SCALE\)/);
  assert.doesNotMatch(projectedBody, /softness\.mul\(TEXTURE_AIRBRUSH_SOFT_HALO_SCALE\)/);
  assert.doesNotMatch(body, /scatter\.mul\(0\.15\)/);
  assert.doesNotMatch(projectedBody, /scatter\.mul\(0\.15\)/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(1\)\.add\(scatter\.mul\(0\.15\)\)\)\.toVar\(\)/);
  assert.doesNotMatch(body, /tailAlpha|tailCoverage|tailSmooth/);
  assert.match(body, /const fadeRadius = max\(haloRadius\.sub\(coreRadius\), 0\.0001\)/);
  assert.match(projectedBody, /const fadeRadius = max\(haloRadius\.sub\(coreRadius\), 0\.0001\)/);
  assert.match(body, /const edgeCoverage = max\(0\.0, float\(1\)\.sub\(smoothEdge\)\)\.toVar\(\)/);
  assert.match(body, /const screenCoverage = edgeCoverage\.toVar\(\)/);
  assert.match(body, /const segmentViewEnds = uniformArray/);
  assert.doesNotMatch(body, /const viewEnd = segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(body, /const visibleDepthGate =/);
  assert.doesNotMatch(body, /const viewRadius = max\(mix\(viewStart\.w, viewEnd\.w, viewT\), 0\.0001\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const viewDistancePixels/);
  assert.doesNotMatch(body, /const viewDistanceCoverage = viewEdgeCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(body, /normalCompatibility|surfacePlanePermission/);
  assert.match(body, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const surfaceCoverage =/);
  assert.doesNotMatch(body, /screenGate/);
  assert.doesNotMatch(body, /surfaceCoverage\.mul\(screenGate\)/);
  assert.doesNotMatch(body, /viewContinuityCoverage|viewContinuityFade|viewContinuitySmoothFade/);
  assert.match(body, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(visibilityCoverage\)/);
  assert.doesNotMatch(body, /const surfaceFieldCoverage = brushFieldCoverage\.mul\(depthGate\)/);
  assert.doesNotMatch(body, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(hasViewGate\.select\(viewCoverage, float\(1\)\)\)/);
  assert.match(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthGate\)[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /visibleCoverage|visiblePermission|visibleSoftPermission|visibleGateCoverage/);
  assert.doesNotMatch(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentPermission\)/);
  assert.doesNotMatch(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(bridgePermission\)/);
  assert.match(body, /const exponent = max\(\s*1\.0,/);
  assert.match(body, /const shapedEdge = clamp\(pow\(normalized, exponent\), 0\.0, 1\.0\)\.toVar\(\)/);
  assert.match(body, /const smoothEdge = shapedEdge\.mul\(shapedEdge\)\.mul\(float\(3\)\.sub\(shapedEdge\.mul\(2\)\)\)\.toVar\(\)/);
  assert.match(body, /const edgeCoverage = max\(0\.0, float\(1\)\.sub\(smoothEdge\)\)\.toVar\(\)/);
  assert.match(body, /alpha\.lessThanEqual\(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD\)/);
  assert.doesNotMatch(body, /float\(1\)\.sub\(pow\(normalized, exponent\)\)/);
  assert.match(body, /opacity\.mul\(strength\)\.mul\(coverage\)/);
  assert.equal(TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE, 0.72);
  assert.equal(TEXTURE_AIRBRUSH_SOFT_HALO_SCALE, 0.85);
  assert.equal(TEXTURE_AIRBRUSH_CORE_MIN_SCALE, 0);
  assert.equal(TEXTURE_AIRBRUSH_CORE_HARDNESS_POWER, 1.35);
  assert.equal(TEXTURE_AIRBRUSH_CORE_HARDNESS_SCALE, 0.58);
  assert.equal(TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE, 1.0);
  assert.equal(TEXTURE_AIRBRUSH_EDGE_HARDNESS_POWER, 2.2);
  assert.equal(TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE, 15);
  assert.equal(TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE, 0.85);
});

test("TSL surface airbrush can gate ambiguous UV overlap texels", () => {
  assert.equal(SURFACE_UV_OWNERSHIP_MASK_SIZE, 1024);
  assert.equal(SURFACE_UV_OWNERSHIP_DISTANCE_THRESHOLD, 0.25);
  assert.match(source, /function surfaceAirbrushUvOverlapMaskEnabled/);
  assert.match(source, /debugAirbrushNoUvOverlapMask/);
  assert.match(source, /function sourceObjectUvOverlapMaskTexture/);
  assert.match(source, /buildSurfaceUvOwnershipMask\(geometry\)/);
  assert.match(uvOwnershipSource, /function trianglesShareSurfaceEdge/);
  assert.match(uvOwnershipSource, /function trianglesHaveAmbiguousUvOverlap/);
  assert.match(uvOwnershipSource, /positionKeys: points\.map\(\(point\) => positionKey\(point\)\)/);
  assert.match(uvOwnershipSource, /trianglesHaveAmbiguousUvOverlap\(triangles\[previous\], triangle\)/);
  assert.match(source, /new THREE\.DataTexture/);
  const body = functionSource("createSurfaceMaterial");
  assert.match(body, /const allowAmbiguousUvOverlap = options\.allowAmbiguousUvOverlap === true/);
  assert.match(body, /const overlapMaskTexture = allowAmbiguousUvOverlap[\s\S]*?\? surfaceAirbrushWhiteMaskTexture\(\)[\s\S]*?: sourceObjectUvOverlapMaskTexture\(sourceObject\)/);
  assert.match(body, /const overlapMaskTextureNode = texture\(overlapMaskTexture, paintUv\)/);
  assert.match(body, /const uvOverlapMaskEnabled = uniform\(allowAmbiguousUvOverlap \? 0 : 1, "float"\)/);
  assert.match(body, /const overlapSample = overlapMaskTextureNode\.toVar\(\)/);
  assert.match(body, /const overlapCanWrite = uvOverlapMaskEnabled\.lessThan\(0\.5\)[\s\S]*?\.or\(overlapSample\.r\.greaterThan\(0\.5\)\)/);
  assert.match(body, /\.or\(occupancySample\.r\.lessThan\(0\.5\)\)[\s\S]*?\.and\(overlapCanWrite\)/);
  assert.match(body, /const uvOwnershipGate = overlapCanWrite\.select\(float\(1\), float\(0\)\)\.toVar\(\)/);
  assert.match(body, /const sourceCoverage = originalMeshUvRaster[\s\S]*?\? gatedCoverage\.mul\(uvOwnershipGate\)\.toVar\(\)[\s\S]*?: gatedCoverage\.mul\(gutterCanWrite\.select\(float\(1\), float\(0\)\)\)\.toVar\(\)/);
  assert.match(source, /tslSurfaceOverlapMaskAmbiguousTexels/);
});

test("TSL stroke masks select shared UV texels while direct paint keeps ownership gating", () => {
  const policyBody = functionSource("surfaceAirbrushAllowsAmbiguousUvOverlap");
  const rasterBody = functionSource("ensureUvRasterMeshes");
  const updateBody = functionSource("updateSurfaceMaterial");
  const prewarmBody = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");

  assert.match(policyBody, /options\.allowAmbiguousUvOverlap === true \|\| options\.maskOnly === true/);
  assert.match(policyBody, /editable\?\.layerMode === true/);
  assert.match(policyBody, /String\(editable\?\.layer\?\.kind \|\| ""\)\.toLowerCase\(\) === "fixup-mask"/);
  assert.match(rasterBody, /allowAmbiguousUvOverlap: options\.allowAmbiguousUvOverlap === true/);
  assert.match(updateBody, /state\.uvOverlapMaskEnabled\.value = allowAmbiguousUvOverlap \? 0 : 1/);
  assert.match(updateBody, /!allowAmbiguousUvOverlap[\s\S]*?sourceObjectUvOverlapMaskTexture\(state\.sourceObject\)/);
  assert.match(prewarmBody, /const allowAmbiguousUvOverlap = surfaceAirbrushAllowsAmbiguousUvOverlap\(editable, \{[\s\S]*?maskOnly: true[\s\S]*?\}\)/);
  assert.match(prewarmBody, /maskOnly: true,[\s\S]*?allowAmbiguousUvOverlap/);
  assert.match(runBody, /const useStrokeMaskComposite = !useProjectedPrimary[\s\S]*?const allowAmbiguousUvOverlap = surfaceAirbrushAllowsAmbiguousUvOverlap\(editable, \{[\s\S]*?maskOnly: useStrokeMaskComposite[\s\S]*?\}\)/);
  assert.match(runBody, /maskOnly: useStrokeMaskComposite,[\s\S]*?allowAmbiguousUvOverlap/);
});

test("TSL compile-only prewarm queues shaders without rasterizing the texture atlas", () => {
  const body = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  const compileBranchStart = body.indexOf("if (compileOnly) {");
  const compileBranchEnd = body.indexOf("if (options.renderCompilePass === true", compileBranchStart);
  const compileBranch = body.slice(compileBranchStart, compileBranchEnd);

  assert.ok(compileBranchStart >= 0);
  assert.ok(compileBranchEnd > compileBranchStart);
  assert.match(body, /const visibleTarget = compileOnly[\s\S]*?\? ensureVisibleSurfaceResources\(/);
  assert.match(body, /compileOnly,[\s\S]*?originalMeshUvRaster: prewarmOriginalMeshUvRaster/);
  assert.match(compileBranch, /schedulePrewarmCompilePass\(/);
  assert.match(compileBranch, /compileOnly: true/);
  assert.doesNotMatch(compileBranch, /renderer\.render\(/);
  assert.doesNotMatch(compileBranch, /renderVisibleSurfaceTarget\(/);
});

test("UV ownership rejects disconnected triangles that share texture coordinates", () => {
  const attribute = (values, itemSize) => ({
    count: values.length / itemSize,
    getX(index) { return values[index * itemSize]; },
    getY(index) { return values[index * itemSize + 1]; },
    getZ(index) { return values[index * itemSize + 2] || 0; }
  });
  const geometry = {
    uuid: "overlapping-uv-test",
    attributes: {
      position: attribute([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        10, 0, 0, 11, 0, 0, 10, 1, 0
      ], 3),
      uv: attribute([
        0, 0, 1, 0, 0, 1,
        0, 0, 1, 0, 0, 1
      ], 2)
    }
  };

  const mask = buildSurfaceUvOwnershipMask(geometry, { size: 32 });

  assert.equal(mask.triangleCount, 2);
  assert.ok(mask.ambiguousTexels > 0);
  const center = (8 * mask.size + 8) * 4;
  assert.equal(mask.data[center], 0, "shared UV texels must not be writable");
  assert.equal(mask.data[center + 3], 255);
});

test("TSL surface airbrush raster scopes paint by source material index", () => {
  assert.match(source, /function surfaceRasterMaterialsForSourceObject/);
  const body = functionSource("surfaceRasterMaterialsForSourceObject");
  assert.match(body, /sourceObjectMaterialPaintIndices/);
  assert.match(body, /paintIndices\.has\(index\) \? paintMaterial : noopMaterial/);
});

test("TSL full-surface raster can scope material slots by editable texture", () => {
  const scopeBody = functionSource("sourceObjectMaterialPaintIndices");
  const runBody = functionSource("ensureUvRasterMeshes");
  const projectedBody = functionSource("meshUvProjectedTriangles");
  assert.match(scopeBody, /includeAllMaterialIndices === true/);
  assert.match(scopeBody, /indices\.add\(index\)/);
  assert.match(scopeBody, /materialUsesEditableTexture/);
  assert.match(runBody, /surfaceRasterMaterialsForSourceObject/);
  assert.doesNotMatch(projectedBody, /includeAllMaterialIndices: true/);
});

test("TSL live source-mesh raster always includes source material slots", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const scopeHelperBody = functionSource("materialScopeOptionsForSourceObject");
  const rasterBody = functionSource("ensureUvRasterMeshes");
  const occupancyBody = functionSource("ensureUvOccupancyMask");
  assert.match(functionSource("sourceObjectsForEditable"), /options\.restrictSourceRasterToCandidateObject === true[\s\S]*?addUniqueSourceObject\(output, seen, fallbackObject\)[\s\S]*?return output/);
  assert.match(body, /sourceObjectsForEditable\(editor, candidate, editable, sourceTexture, referenceTexture, \{[\s\S]*?restrictSourceRasterToCandidateObject: options\.neighborPaintSeed\?\.enabled === true[\s\S]*?\|\| options\.largeLiveNeighborPaint === true[\s\S]*?\}\)/);
  assert.match(body, /const materialScopeOptions = \{\}/);
  assert.doesNotMatch(body, /debugAirbrushAllMaterialSlots/);
  assert.doesNotMatch(body, /includeFallbackObjectMaterialIndices: true/);
  assert.match(scopeHelperBody, /delete scoped\.includeFallbackObjectMaterialIndices/);
  assert.doesNotMatch(scopeHelperBody, /restrictFallback/);
  assert.doesNotMatch(scopeHelperBody, /restrictToFallbackMaterialIndex = true/);
  assert.doesNotMatch(scopeHelperBody, /\{ \.\.\.options, includeAllMaterialIndices: true \}/);
  assert.match(rasterBody, /materialScopeOptionsForSourceObject\(options, sourceObject, fallbackSourceObject\)/);
  assert.match(occupancyBody, /materialScopeOptionsForSourceObject\(options, sourceObject, fallbackSourceObject\)/);
  assert.doesNotMatch(body, /debugAirbrushScopedMaterialSlots/);
  assert.match(body, /sourceRasterOptions = \{[\s\S]*?\.\.\.materialScopeOptions/);
  assert.doesNotMatch(body, /const sourceObjects = \[sourceObject\]\.filter\(Boolean\)/);
});

test("TSL surface airbrush recognizes cloned editable texture images across material slots", () => {
  const body = functionSource("materialUsesEditableTexture");
  const textureSetBody = functionSource("surfaceEditableTextureSet");
  assert.match(body, /materialMap\?\.image \|\| materialMap\?\.source\?\.data/);
  assert.match(body, /materialLinkedToEditable/);
  assert.match(body, /materialImage && editableImages\.has\(materialImage\)/);
  assert.match(body, /materialImage && textureImage && materialImage === textureImage/);
  assert.match(body, /textures\.has\(userData\.clonePaintOriginalMap\)/);
  assert.match(textureSetBody, /clonePaintOriginalMap/);
  assert.doesNotMatch(body, /userData\.clonePaintOriginalMap\?\.image,[\s\S]*?userData\.clonePaintOriginalMap\?\.source\?\.data/);
});

test("TSL surface airbrush does not rebind live targets by loose source-image matches", () => {
  const matcherBody = functionSource("materialUsesEditableTexture");
  const bindBody = functionSource("bindSurfaceTextureToMatchingMaterials");
  assert.match(matcherBody, /const allowImageMatch = options\.allowImageMatch === true/);
  assert.match(matcherBody, /allowImageMatch && materialImage && editableImages\.has\(materialImage\)/);
  assert.match(matcherBody, /allowImageMatch && materialImage && textureImage && materialImage === textureImage/);
  assert.match(bindBody, /allowImageMatch: options\.allowImageMatch === true/);
  assert.doesNotMatch(bindBody, /allowImageMatch: true/);
});

test("TSL surface airbrush does not use unpainted cache display targets as stroke bases", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const cacheBody = functionSource("ensureSurfaceAirbrushCache");
  const referenceBody = functionSource("surfaceAirbrushReferenceTexture");
  assert.match(cacheBody, /hasPaintedSurfaceStroke: false/);
  assert.match(referenceBody, /!surfaceAirbrushCacheOwnsTexture\(cache, editableTexture\)/);
  assert.match(referenceBody, /!surfaceAirbrushCacheOwnsTexture\(cache, displayTexture\)/);
  assert.doesNotMatch(referenceBody, /displayIsCurrentCacheTarget/);
  assert.match(body, /&& cache\.hasPaintedSurfaceStroke === true/);
  assert.match(body, /cache\.hasPaintedSurfaceStroke = false/);
  assert.match(body, /cache\.hasPaintedSurfaceStroke = true/);
});

test("TSL surface airbrush marks materials dirty when texture-node bindings change", () => {
  const body = functionSource("updateSurfaceMaterial");
  assert.match(body, /const previousSourceTexture = state\.sourceTextureNode\.value/);
  assert.match(body, /const previousVisibleTexture = state\.visibleTextureNode\?\.value \|\| null/);
  assert.match(body, /const previousUvOccupancyTexture = state\.uvOccupancyTextureNode\?\.value \|\| null/);
  assert.match(body, /material\.needsUpdate = true/);
});

test("TSL surface airbrush keeps projected gutter mesh separate from source raster mesh", () => {
  const body = functionSource("ensureProjectedSurfaceMesh");
  assert.match(body, /cache\.projectedMesh/);
  assert.match(body, /if \(!cache\.projectedMesh\)/);
  assert.doesNotMatch(body, /cache\.mesh = new THREE\.Mesh/);
  assert.doesNotMatch(body, /cache\.ownsMeshGeometry/);
  assert.match(source, /tslSurfaceProjectedGutterTriangleCount/);
});

test("TSL surface airbrush reuses projected gutter geometry capacity during live drag", () => {
  assert.match(source, /function updateSurfaceGeometry/);
  assert.match(source, /texturePaintTslSurfaceCapacityVertices/);
  assert.match(source, /geometry\.setDrawRange\(0, data\.vertexCount\)/);
  assert.match(source, /paintBarycentric/);
  assert.match(source, /surfaceGeometryDrawTriangleCount\(projectedMesh\?\.geometry\)/);
});

test("TSL source raster uses UV seam bleed by default", () => {
  assert.match(source, /const SOURCE_RASTER_GEOMETRY_MIN_TRIANGLES = 512/);
  assert.match(source, /const UV_GUTTER_PIXELS = 0/);
  assert.match(source, /const UV_SEAM_BLEED_PIXELS = 8/);
  const sourceRasterModeBody = functionSource("surfaceAirbrushOriginalMeshUvRasterEnabled");
  assert.match(sourceRasterModeBody, /debugAirbrushOriginalMeshUvRaster/);
  assert.match(sourceRasterModeBody, /debugAirbrushSourceMeshUvRaster/);
  assert.match(sourceRasterModeBody, /return false;/);
  assert.doesNotMatch(sourceRasterModeBody, /return true;/);
  assert.match(source, /debugAirbrushNoSourceGutters/);
  assert.match(functionSource("surfaceAirbrushSourceRasterGutterPixels"), /return UV_SEAM_BLEED_PIXELS/);
  assert.match(source, /function sourceRasterGeometryData/);
  assert.match(source, /expandedTrianglePoints\(pixels\[0\], pixels\[1\], pixels\[2\], gutterPixels\)/);
  assert.match(source, /function projectedTriangleSourcePixels/);
  assert.match(source, /const sourcePixels = projectedTriangleSourcePixels\(triangle\) \|\| pixels/);
  assert.match(source, /clampBarycentricToTriangle/);
  assert.match(source, /interpolatePoint2\(clampedBarycentric, sourcePixels\[0\], sourcePixels\[1\], sourcePixels\[2\]\)/);
  assert.match(source, /writeTexture: rasterWriteTexture/);
  assert.match(source, /rasterWidth: rasterWriteSize\.width/);
  assert.match(source, /rasterHeight: rasterWriteSize\.height/);
  assert.match(source, /const sampleSize = textureLikeSize\(sampleTexture\)/);
  assert.match(source, /texturePixelForUv\(uvAttribute, ia, sampleTexture, sampleSize\.width, sampleSize\.height\)/);
  assert.match(source, /const view = interpolateView\(barycentric, views\[0\], views\[1\], views\[2\]\)[\s\S]*?\|\| interpolateView\(clampedBarycentric, views\[0\], views\[1\], views\[2\]\)/);
  assert.match(source, /const screen = interpolateScreen\(barycentric, screens\[0\], screens\[1\], screens\[2\]\)[\s\S]*?\|\| interpolateScreen\(clampedBarycentric, screens\[0\], screens\[1\], screens\[2\]\)/);
  assert.match(source, /const normal = interpolateNormal\(barycentric, normals\[0\], normals\[1\], normals\[2\]\)[\s\S]*?\|\| interpolateNormal\(clampedBarycentric, normals\[0\], normals\[1\], normals\[2\]\)/);
  assert.match(source, /function createSourceUvRasterMesh/);
  assert.match(source, /function ensureSourceUvRasterGeometry/);
  assert.match(source, /updateSourceRasterGeometry/);
  assert.match(source, /function ensureUvOccupancyMask/);
  assert.match(source, /createUvOccupancyTarget/);
  assert.match(source, /createUvOccupancyMaterial/);
  assert.match(source, /new THREE\.BufferAttribute\(surfaceGeometryAttributeArray\(data\.arrays\.sourceUv/);
  assert.match(source, /new THREE\.BufferAttribute\(surfaceGeometryAttributeArray\(data\.arrays\.normal/);
  assert.match(source, /new THREE\.BufferAttribute\(surfaceGeometryAttributeArray\(data\.arrays\.barycentric/);
  const materialBody = functionSource("createSurfaceMaterial");
  assert.match(materialBody, /const paintUv = varyingProperty\("vec2", "vTexturePaintSourceUv"\)/);
  assert.match(materialBody, /const paintBarycentric = varyingProperty\("vec3", "vTexturePaintSourceBarycentric"\)/);
  assert.match(materialBody, /paintUv\.assign\(attribute\("sourceUv", "vec2"\)\)/);
  assert.match(materialBody, /paintNormal\.assign\(attribute\("paintNormal", "vec3"\)\)/);
  assert.match(materialBody, /paintBarycentric\.assign\(attribute\("paintBarycentric", "vec3"\)\)/);
  assert.match(materialBody, /const occupancySample = uvOccupancyTextureNode\.toVar\(\)/);
  assert.match(materialBody, /const overlapSample = overlapMaskTextureNode\.toVar\(\)/);
  assert.match(materialBody, /gutterCanWrite = insideOriginalTriangle[\s\S]*?\.or\(occupancySample\.r\.lessThan\(0\.5\)\)[\s\S]*?\.and\(overlapCanWrite\)/);
  assert.match(materialBody, /\.mul\(gutterCanWrite\.select\(float\(1\), float\(0\)\)\)/);
  assert.match(materialBody, /return vec4\(positionLocal\.x, positionLocal\.y, 0, 1\)/);
  assert.match(materialBody, /paintNormal\.assign\(attribute\("paintNormal", "vec3"\)\)/);
});

test("TSL surface airbrush keeps scoped projected triangles opt-in instead of the live primary", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const candidateBody = functionSource("candidateProjectedTriangles");
  const geometryBody = functionSource("createSurfaceGeometry");
  const updateGeometryBody = functionSource("updateSurfaceGeometry");
  assert.match(body, /debugAirbrushDisableProjectedGutters/);
  assert.match(body, /debugAirbrushProjectedPrimary/);
  assert.match(body, /debugAirbrushFullProjectedMesh/);
  assert.match(body, /debugAirbrushFullSurfaceRaster/);
  assert.match(body, /const projectedGuttersDisabled = debugParams\?\.has\("debugAirbrushDisableProjectedGutters"\) === true/);
  assert.match(body, /debugParams\?\.has\("debugAirbrushProjectedPrimary"\) === true/);
  assert.match(body, /const candidateTriangles = candidateProjectedTriangles\(candidate, options\)/);
  assert.match(candidateBody, /options\.visibilityMaskTriangles/);
  assert.match(candidateBody, /candidate\?\.options\?\.visibilityMaskTriangles/);
  assert.match(body, /const candidateProjectedPrimaryAvailable = candidateTriangles\.length > 0 && !forceFullProjectedMesh/);
  assert.match(body, /const projectedPrimaryRequested = debugParams\?\.has\("debugAirbrushProjectedPrimary"\) === true[\s\S]*?\|\| options\.projectedPrimary === true[\s\S]*?\|\| candidate\?\.options\?\.projectedPrimary === true/);
  assert.match(body, /const preferProjectedPrimary = projectedGuttersDisabled !== true[\s\S]*?&& projectedPrimaryRequested[\s\S]*?&& candidateProjectedPrimaryAvailable/);
  assert.doesNotMatch(body, /candidateProjectedPrimaryAvailable[\s\S]*?&& \(options\.liveProjectedPaint === true \|\| options\.screenStrokePaint === true\)/);
  assert.match(body, /const useCandidateProjectedPrimary = Boolean/);
  assert.match(body, /&& candidateProjectedPrimaryAvailable/);
  assert.match(body, /const forceFullProjectedGutters = debugParams\?\.has\("debugAirbrushFullProjectedGutters"\) === true/);
  assert.match(body, /const projectedGuttersRequested = forceFullProjectedGutters === true[\s\S]*?debugAirbrushProjectedGutters[\s\S]*?debugAirbrushCandidateProjectedGutters[\s\S]*?options\.projectedGutters === true/);
  assert.match(body, /const enableProjectedGutters = projectedGuttersDisabled !== true[\s\S]*?&& !useCandidateProjectedPrimary[\s\S]*?&& projectedGuttersRequested/);
  assert.match(body, /const candidateProjectedGuttersRequested = forceFullProjectedGutters !== true[\s\S]*?debugAirbrushCandidateProjectedGutters/);
  assert.doesNotMatch(body, /const liveProjectedGutterStroke/);
  assert.match(body, /const useCandidateProjectedGutters = Boolean\([\s\S]*?enableProjectedGutters[\s\S]*?candidateProjectedGuttersRequested[\s\S]*?candidateTriangles\.length/);
  assert.match(body, /const useProjectedPrimary = Boolean/);
  assert.match(body, /cachedMeshUvProjectedTriangles\(cache, editor, candidate, width, height\)/);
  assert.match(body, /rawProjectedTriangles/);
  assert.match(body, /useCandidateProjectedPrimary\s+\?\s+candidateTriangles/);
  assert.match(body, /enableProjectedGutters\s+\?\s+candidateTriangles\s+:\s+\[\]/);
  assert.doesNotMatch(body, /meshProjectedTriangles\.length\s+\?\s+meshProjectedTriangles\s+:\s+candidateTriangles/);
  assert.match(source, /function projectedTrianglePlaneNormals/);
  assert.match(source, /const normals = projectedTriangleNormals\(triangle\) \|\| projectedTrianglePlaneNormals\(views\)/);
  assert.match(geometryBody, /"paintNormal"/);
  assert.match(geometryBody, /data\.arrays\.normal/);
  assert.match(updateGeometryBody, /\["paintNormal", data\.arrays\.normal\]/);
  assert.match(body, /const useStrokeMaskComposite = !useProjectedPrimary/);
  assert.match(body, /const newlyAppendedPaintSegments = Array\.isArray\(cache\.lastSurfaceStrokeAppendSegments\)/);
  assert.match(body, /const renderPaintSegments = useStrokeMaskComposite[\s\S]*?newlyAppendedPaintSegments[\s\S]*?: paintSegments/);
  assert.match(source, /const MAX_TSL_SURFACE_SEGMENTS = Math\.min\(48, TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS\)/);
  assert.match(source, /const MAX_TSL_SURFACE_STROKE_SEGMENTS = TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS/);
  assert.match(source, /function chunkSurfaceSegmentsForShader/);
  assert.match(body, /const filteredProjectedTriangles = filterProjectedTrianglesForScreenBrush\(rawProjectedTriangles, renderPaintSegments, options\)/);
  assert.match(body, /const projectedTriangles = useStrokeMaskComposite[\s\S]*?\? \[\][\s\S]*?: useProjectedPrimary[\s\S]*?\? \(filteredProjectedTriangles\.length \? filteredProjectedTriangles : rawProjectedTriangles\)[\s\S]*?: filteredProjectedTriangles/);
  assert.match(body, /filterProjectedTrianglesForScreenBrush\(rawProjectedTriangles, renderPaintSegments, options\)/);
  assert.match(source, /function screenBoundsExpand/);
  assert.match(source, /function screenBoundsUnion/);
  assert.match(functionSource("meshUvProjectedTriangles"), /const uvPixels = new Array\(vertexCount\)/);
  assert.match(functionSource("meshUvProjectedTriangles"), /const screenPoints = new Array\(vertexCount\)/);
  assert.match(functionSource("meshUvProjectedTriangles"), /const viewNormals = new Array\(vertexCount\)/);
  assert.match(functionSource("meshUvProjectedTriangles"), /const getScreenPoint = \(vertexIndex = 0\)/);
  assert.match(functionSource("meshUvProjectedTriangles"), /screenBounds: screenBoundsForPoints\(\[screenA, screenB, screenC\]\)/);
  assert.match(functionSource("filterProjectedTrianglesForScreenBrush"), /const domainSegments = simplifiedSourceRasterClipSegments\(segments, 24\)/);
  assert.match(functionSource("filterProjectedTrianglesForScreenBrush"), /const strokeBounds = screenBoundsUnion/);
  assert.match(functionSource("filterProjectedTrianglesForScreenBrush"), /triangle\?\.screenBounds \|\| screenBoundsForPoints/);
  assert.doesNotMatch(body, /useProjectedPrimary \? 0 : UV_GUTTER_PIXELS/);
  assert.match(body, /ensureProjectedSurfaceMesh\([\s\S]*?baseTexture,\s*\n\s*UV_SEAM_BLEED_PIXELS/);
  assert.doesNotMatch(body, /ensureProjectedSurfaceMesh\([\s\S]*?referenceTexture,\s*\n\s*UV_SEAM_BLEED_PIXELS/);
  assert.match(body, /entry\.mesh\.visible = !useProjectedPrimary/);
  assert.match(body, /projectedPaintGutterOnly: !useProjectedPrimary/);
  assert.match(source, /function cachedMeshUvProjectedTriangles/);
  assert.match(source, /meshUvProjectedTrianglesKey/);
  assert.match(source, /projectedGeometryTriangles === triangles/);
  assert.doesNotMatch(functionSource("meshUvProjectedTrianglesCacheKey"), /texture\.uuid \|\| texture\.id/);
  assert.doesNotMatch(functionSource("meshUvProjectedTrianglesCacheKey"), /material\?\.map\?\.uuid/);
  assert.match(body, /cachedMeshUvProjectedTriangles\(cache, editor, candidate, width, height\)/);
  assert.doesNotMatch(body, /updateSurfaceMaterial\(entry\.material, baseTexture, \[\], options, editor, visibleTexture\)/);
  assert.doesNotMatch(body, /const preferProjectedPrimary = !disableProjectedPrimary/);
  assert.match(body, /screen-and-view-source-mesh"/);
  assert.match(body, /screen-and-view-source-mesh-with-projected-gutters/);
  assert.match(body, /screen-and-view-projected-triangles/);
  assert.match(source, /function surfaceAirbrushSourceRasterClipEnabled/);
  assert.match(source, /debugAirbrushSourceRasterClip/);
  assert.doesNotMatch(functionSource("surfaceAirbrushSourceRasterClipEnabled"), /return false/);
  assert.match(functionSource("surfaceAirbrushSourceRasterClipEnabled"), /has\("debugAirbrushSourceRasterClip"\)/);
  assert.doesNotMatch(body, /debugAirbrushClipSourceRaster/);
  assert.match(source, /function surfaceAirbrushOriginalMeshUvRasterEnabled/);
  assert.match(source, /debugAirbrushSourceMeshUvRaster/);
  assert.doesNotMatch(source, /debugAirbrushExpandedSourceUvRaster/);
  assert.doesNotMatch(body, /const liveSurfaceStrokeForRasterClip = options\.liveProjectedPaint === true \|\| options\.screenStrokePaint === true/);
  assert.match(body, /const liveProjectedPaint = options\.liveProjectedPaint === true/);
  assert.match(body, /const screenStrokePaint = options\.screenStrokePaint === true/);
  assert.match(body, /const liveStrokeMaskComposite = useStrokeMaskComposite[\s\S]*?&& \(liveProjectedPaint \|\| screenStrokePaint\)/);
  assert.match(body, /const useSourceRasterClip = useStrokeMaskComposite\s+&& surfaceAirbrushSourceRasterClipEnabled\(\)/);
  assert.doesNotMatch(body, /const useSourceRasterClip = !layerMode\s+&& useStrokeMaskComposite/);
  assert.match(body, /const sourceRasterClipPath = useSourceRasterClip[\s\S]*?simplifiedSourceRasterClipSegments\(renderPaintSegments, MAX_TSL_SURFACE_SEGMENTS\)/);
  assert.match(body, /const useOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled\(\)/);
  assert.match(body, /originalMeshUvRaster: useOriginalMeshUvRaster/);
  assert.match(body, /sourceRasterClipSegments: sourceRasterClipPath/);
  assert.match(body, /sourceRasterClipRequired: useSourceRasterClip/);
  assert.match(body, /const sourceRasterClipSegmentCount = sourceRasterClipSegments\(sourceRasterOptions\)\.length/);
  assert.match(body, /tslSurfaceSourceRasterClipSegmentCount: sourceRasterClipSegmentCount/);
  assert.match(body, /tslSurfaceSourceRasterClipActive: sourceRasterOptions\.sourceRasterClipRequired === true[\s\S]*?&& sourceRasterClipSegmentCount > 0/);
  assert.doesNotMatch(body, /sourceRasterClipSegments: paintSegments/);
  const clipRadiusBody = functionSource("sourceRasterClipDomainRadius");
  assert.match(clipRadiusBody, /scatter \* TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE/);
  assert.doesNotMatch(clipRadiusBody, /SCATTER_OUTER_RADIUS_SCALE/);
  assert.match(clipRadiusBody, /const hardness = sourceRasterClipHardness\(options\)/);
  assert.match(clipRadiusBody, /const softness = 1 - hardness/);
  assert.match(clipRadiusBody, /softness \* TEXTURE_AIRBRUSH_SOFT_HALO_SCALE/);
  assert.match(functionSource("sourceRasterClipKey"), /sourceRasterClipHardness\(options\)/);
  assert.match(functionSource("sourceRasterClipKey"), /finiteComponentId\(segment\.componentStart\)/);
  assert.match(functionSource("sourceRasterClipKey"), /finiteComponentId\(segment\.componentEnd\)/);
  const sourceRasterClipSegmentsBody = functionSource("sourceRasterClipSegments");
  assert.match(sourceRasterClipSegmentsBody, /finitePoint\(segment\?\.start\) \|\| finitePoint\(segment\?\.screenStart\)/);
  assert.match(sourceRasterClipSegmentsBody, /finitePoint\(segment\?\.end\) \|\| finitePoint\(segment\?\.screenEnd\)/);
  assert.match(sourceRasterClipSegmentsBody, /const viewStart = finiteView\(segment\?\.viewStart\)/);
  assert.match(sourceRasterClipSegmentsBody, /const viewEnd = finiteView\(segment\?\.viewEnd\)/);
  assert.match(sourceRasterClipSegmentsBody, /segment\?\.viewRadius[\s\S]*?segment\?\.worldRadius[\s\S]*?segment\?\.viewRadiusPixels/);
  assert.match(sourceRasterClipSegmentsBody, /const componentStart = finiteComponentId\(segment\?\.componentStart\)/);
  assert.match(sourceRasterClipSegmentsBody, /const componentEnd = finiteComponentId\(segment\?\.componentEnd\)/);
  const sourceRasterClipKeyBody = functionSource("sourceRasterClipKey");
  assert.match(sourceRasterClipKeyBody, /roundedSurfaceKeyNumber\(segment\.viewStart\?\.x, 1000\)/);
  assert.match(sourceRasterClipKeyBody, /roundedSurfaceKeyNumber\(segment\.viewEnd\?\.z, 1000\)/);
  assert.match(sourceRasterClipKeyBody, /roundedSurfaceKeyNumber\(segment\.viewRadius, 1000\)/);
  assert.match(sourceRasterClipKeyBody, /sourceRasterClipComponentGateEnabled\(options\) \? "component" : "all-components"/);
  assert.match(functionSource("screenTriangleNearSourceRasterClip"), /sourceRasterClipRequired === true \? false : true/);
  assert.doesNotMatch(source, /function viewTriangleNearSourceRasterClip/);
  assert.doesNotMatch(functionSource("screenTriangleNearSourceRasterClip"), /viewTriangleNearSourceRasterClip\(screenPoints, segment\)/);
  assert.match(body, /sourceRasterClipHardness: options\.hardness/);
  assert.match(source, /function simplifiedSourceRasterClipSegments/);
  assert.match(source, /const TSL_SURFACE_DILATION_PASSES = 1/);
  assert.match(source, /const TSL_SURFACE_STROKE_MASK_DILATION_PASSES = 1/);
});

test("TSL source raster dispatch constrains components without changing brush field shape", () => {
  const sourceRasterClipBody = functionSource("screenTriangleNearSourceRasterClip");
  const sourceRasterTrianglesBody = functionSource("sourceUvRasterTriangles");
  const exposeStart = strokeSource.indexOf("const exposeSurfaceComponentIds = Boolean");
  assert.notEqual(exposeStart, -1, "component exposure decision should exist");
  const strokeBody = strokeSource.slice(
    exposeStart,
    strokeSource.indexOf("const stripSurfaceComponents", exposeStart)
  );
  assert.match(source, /function sourceRasterClipSegmentAllowsComponent/);
  assert.doesNotMatch(source, /function sourceRasterClipHasComponentConstraint/);
  assert.doesNotMatch(sourceRasterClipBody, /componentConstrained/);
  assert.match(sourceRasterClipBody, /sourceRasterClipSegmentAllowsComponent\(segment, componentId, options\)/);
  assert.match(sourceRasterTrianglesBody, /screenTriangleNearSourceRasterClip\(\[screenA, screenB, screenC\], options, componentId\)/);
  assert.match(sourceRasterTrianglesBody, /const componentId = componentIdForTriangleVertices\(componentState, ia, ib, ic\)/);
  assert.match(source, /function sourceRasterAllowedComponentIds/);
  assert.match(source, /function sourceRasterTriangleAllowsComponent/);
  assert.match(functionSource("sourceRasterClipKey"), /sourceRasterAllowedComponentKey\(options\)/);
  assert.match(sourceRasterTrianglesBody, /if \(!sourceRasterTriangleAllowsComponent\(componentId, options\)\) \{[\s\S]*?continue;/);
  assert.match(functionSource("texturePaintRunTslSurfaceAirbrush"), /sourceRasterAllowedComponentIds: options\.sourceRasterAllowedComponentIds/);
  assert.match(source, /tslSurfaceSourceRasterAllowedComponentIds/);
  assert.match(strokeBody, /options\.useTslSurfaceAirbrush !== false/);
  assert.match(strokeBody, /options\.liveProjectedPaint === true/);
  assert.match(strokeBody, /options\.fullProjectedSurfaceRenderTriangles === true/);
  for (const materialBody of [functionSource("createProjectedSurfaceMaterial"), functionSource("createSurfaceMaterial")]) {
    assert.doesNotMatch(materialBody, /sourceRasterClipSegmentAllowsComponent/);
    assert.doesNotMatch(materialBody, /sourceRasterClipHasComponentConstraint/);
    assert.match(materialBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
    assert.match(materialBody, /const componentGateActive = componentGateEnabled[\s\S]*?\.and\(paintComponent\.greaterThan\(0\.5\)\)/);
    assert.doesNotMatch(materialBody, /const surfaceFieldCoverage = brushFieldCoverage\.[^\n]*componentGate/);
    assert.match(materialBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentGate\)/);
  }
});

test("TSL surface airbrush skips duplicate live batches before projected geometry work", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const duplicateIndex = body.indexOf("const duplicateCoveredSegmentsBeforeReset = !surfaceStrokeOwnerChanged(cache, strokeSourceOwner)");
  const projectedIndex = body.indexOf("cachedMeshUvProjectedTriangles(cache, editor, candidate, width, height)");
  const newStrokeIndex = body.indexOf("const startsNewSurfaceStroke = surfaceStrokeStartsNewStroke(cache, strokeSourceOwner, candidate, options, segments, strokeStyleKey)");
  assert.ok(newStrokeIndex > -1, "new-stroke detection should be computed before duplicate skipping");
  assert.ok(duplicateIndex > -1, "duplicate segment detection should be present");
  assert.ok(projectedIndex > -1, "projected mesh collection should still be present");
  assert.ok(
    newStrokeIndex < duplicateIndex,
    "explicit resets and owner changes must win before duplicate skipping"
  );
  assert.ok(
    duplicateIndex < projectedIndex,
    "duplicate batches must skip before CPU projected mesh preparation"
  );
  assert.match(body, /const duplicateCoveredSegments = duplicateCoveredSegmentsBeforeReset[\s\S]*?\|\| \(/);
  assert.match(body, /tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(source, /skippedDuplicateSegments: stats\.tslSurfaceSkippedDuplicateSegments === true/);
  assert.match(source, /textureAirbrushDebugTslSurfaceSkippedRun = JSON\.stringify\(entry\)/);
  assert.match(source, /textureAirbrushDebugTslSurfaceRun = JSON\.stringify\(entry\)/);
  const duplicateBlock = body.slice(duplicateIndex, body.indexOf("const sourceWasMaterialMap", duplicateIndex));
  assert.match(duplicateBlock, /editor\.textureAirbrushLastSkippedWebGpuPaintStats = stats/);
  assert.doesNotMatch(duplicateBlock, /editor\.textureAirbrushLastWebGpuPaintStats = stats/);
});

test("TSL surface airbrush closes narrow stroke-mask cracks before compositing", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const dilationBody = functionSource("runSurfaceDilation");
  const dilationSeedBody = functionSource("createDilationSeedMaterial");
  const updateDilationSeedBody = functionSource("updateDilationSeedMaterial");
  const ensureDilationBody = functionSource("ensureDilationResources");
  const dilationMaterialBody = functionSource("createDilationMaterial");
  const strokeMaskDilationBody = functionSource("surfaceAirbrushStrokeMaskDilationPasses");
  assert.doesNotMatch(body, /const liveSurfaceStroke = options\.liveProjectedPaint === true \|\| options\.screenStrokePaint === true/);
  assert.match(body, /strokeMaskDilationPasses = surfaceAirbrushStrokeMaskDilationPasses\(\)/);
  assert.match(body, /runSurfaceDilation\([\s\S]*?strokeMaskTarget,[\s\S]*?strokeMaskDilationPasses,[\s\S]*?preserveSourceAlpha: true,[\s\S]*?alphaThreshold: 0\.000001,[\s\S]*?sampleAlphaThreshold: TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD,[\s\S]*?interiorOnly: true,[\s\S]*?uvGutter: true,[\s\S]*?uvOccupancyTexture/);
  assert.match(body, /compositeMaskTarget\?\.texture \|\| strokeMaskTarget\.texture/);
  assert.match(body, /const surfaceDilationPasses = useStrokeMaskComposite\s+\?\s+0\s+:\s+projectedGutterTriangleCount > 0\s+\?\s+0\s+:\s+surfaceAirbrushDilationPasses\(\)/);
  assert.match(body, /runSurfaceDilation\([\s\S]*?surfaceDilationPasses,[\s\S]*?\{\s*preserveSourceAlpha: Boolean\(layerMode\)\s*\}/);
  assert.match(functionSource("texturePaintPrewarmTslSurfaceAirbrush"), /const prewarmDilationPasses = surfaceAirbrushDilationPasses\(\)/);
  assert.doesNotMatch(functionSource("texturePaintPrewarmTslSurfaceAirbrush"), /prewarmDilationPasses = layerMode \? 0 : surfaceAirbrushDilationPasses\(\)/);
  assert.match(body, /tslSurfaceDilationPasses: Math\.max\(/);
  assert.match(body, /tslSurfaceStrokeMaskDilation: strokeMaskDilated/);
  assert.match(body, /tslSurfaceStrokeMaskDilationPasses: strokeMaskDilated \? strokeMaskDilationPasses : 0/);
  assert.match(body, /tslSurfaceStrokeMaskUvGutter: strokeMaskDilated && Boolean\(uvOccupancyTexture\)/);
  assert.match(source, /strokeMaskDilation: stats\.tslSurfaceStrokeMaskDilation === true/);
  assert.match(source, /strokeMaskUvGutter: stats\.tslSurfaceStrokeMaskUvGutter === true/);
  assert.match(dilationBody, /passCount = surfaceAirbrushDilationPasses\(\),\s*options = \{\}/);
  assert.match(dilationBody, /const passes = Math\.max\(0, Math\.floor\(finiteNumber\(passCount/);
  assert.match(strokeMaskDilationBody, /const availablePasses = Math\.max\(0, surfaceAirbrushDilationPasses\(\)\)/);
  assert.match(strokeMaskDilationBody, /if \(!availablePasses\) \{[\s\S]*?return 0/);
  assert.match(strokeMaskDilationBody, /debugAirbrushStrokeMaskDilation/);
  assert.match(strokeMaskDilationBody, /return Math\.min\(TSL_SURFACE_STROKE_MASK_DILATION_PASSES, availablePasses\)/);
  assert.match(source, /const TSL_SURFACE_STROKE_MASK_DILATION_PASSES = 1/);
  assert.match(dilationSeedBody, /options = \{\}/);
  assert.match(dilationSeedBody, /const preserveSourceAlpha = options\.preserveSourceAlpha === true/);
  assert.match(dilationSeedBody, /return vec4\(color\.rgb, preserveSourceAlpha \? color\.a : mask\.r\)/);
  assert.match(dilationSeedBody, /transparent: true/);
  assert.match(dilationSeedBody, /blending: THREE\.NoBlending/);
  assert.doesNotMatch(updateDilationSeedBody, /preserveSourceAlpha\.value/);
  assert.match(ensureDilationBody, /cache\.dilationSeedAlphaMaterial \|\|= createDilationSeedMaterial\([\s\S]*?preserveSourceAlpha: true/);
  assert.match(dilationBody, /const seedMaterial = options\.preserveSourceAlpha === true[\s\S]*?cache\.dilationSeedAlphaMaterial[\s\S]*?: cache\.dilationSeedMaterial/);
  assert.match(source, /const TSL_SURFACE_DILATION_SAMPLE_RADII = \[1, 2, 4, 8, 12\]/);
  assert.match(source, /const TSL_SURFACE_STROKE_MASK_BRIDGE_SAMPLE_RADII = \[1, 2, 4, 8, 12, 16\]/);
  assert.match(source, /const TSL_SURFACE_STROKE_MASK_BRIDGE_ALPHA_THRESHOLD = 0\.04/);
  assert.match(source, /const TSL_SURFACE_UV_GUTTER_SAMPLE_RADII = \[1, 2, 4, UV_SEAM_BLEED_PIXELS\]/);
  assert.match(source, /const TSL_SURFACE_UV_GUTTER_OFFSETS = TSL_SURFACE_UV_GUTTER_SAMPLE_RADII\.flatMap/);
  assert.match(dilationMaterialBody, /TSL_SURFACE_DILATION_SAMPLE_RADII\.flatMap/);
  assert.match(dilationMaterialBody, /const alphaThreshold = uniform\(0\.5, "float"\)/);
  assert.match(dilationMaterialBody, /const sampleAlphaThreshold = uniform\(0, "float"\)/);
  assert.match(dilationMaterialBody, /const interiorOnly = uniform\(0, "float"\)/);
  assert.match(dilationMaterialBody, /const uvGutterEnabled = uniform\(0, "float"\)/);
  assert.match(dilationMaterialBody, /result\.a\.lessThan\(alphaThreshold\)/);
  assert.match(dilationMaterialBody, /sample\.a\.greaterThan\(max\(candidate\.a, sampleAlphaThreshold\)\)/);
  assert.match(dilationMaterialBody, /const bridgePairs = TSL_SURFACE_STROKE_MASK_BRIDGE_SAMPLE_RADII[\s\S]*?\.flatMap[\s\S]*?\[\[-radius, -radius\], \[radius, radius\]\]/);
  assert.match(dilationMaterialBody, /If\(interiorOnly\.lessThan\(0\.5\)[\s\S]*?candidate\.assign\(vec4\(sample\.rgb, sample\.a\)\)/);
  assert.match(dilationMaterialBody, /If\(interiorOnly\.greaterThan\(0\.5\)[\s\S]*?const bridgeAlpha = min\(firstSample\.a, secondSample\.a\)\.toVar\(\)/);
  assert.match(dilationMaterialBody, /const bridgeThreshold = max\(sampleAlphaThreshold, float\(TSL_SURFACE_STROKE_MASK_BRIDGE_ALPHA_THRESHOLD\)\)\.toVar\(\)/);
  assert.match(dilationMaterialBody, /bridgeAlpha\.greaterThan\(max\(candidate\.a, bridgeThreshold\)\)[\s\S]*?candidate\.assign\(vec4\(bridgeAlpha, bridgeAlpha, bridgeAlpha, bridgeAlpha\)\)/);
  assert.match(dilationMaterialBody, /uvGutterEnabled\.greaterThan\(0\.5\)\.and\(currentOccupancy\.lessThan\(0\.5\)\)/);
  assert.match(dilationMaterialBody, /TSL_SURFACE_UV_GUTTER_OFFSETS[\s\S]*?sampleOccupancy\.greaterThanEqual\(0\.5\)[\s\S]*?sample\.a\.greaterThan\(max\(candidate\.a, sampleAlphaThreshold\)\)[\s\S]*?candidate\.assign\(vec4\(sample\.rgb, sample\.a\)\)/);
  assert.doesNotMatch(dilationMaterialBody, /leftAxis|rightAxis|topAxis|bottomAxis|horizontalBridge|verticalBridge/);
  assert.match(functionSource("updateDilationMaterial"), /finiteNumber\(options\.alphaThreshold, 0\.5\)/);
  assert.match(functionSource("updateDilationMaterial"), /finiteNumber\(options\.sampleAlphaThreshold, 0\)/);
  assert.match(functionSource("updateDilationMaterial"), /options\.interiorOnly === true \? 1 : 0/);
  assert.match(functionSource("updateDilationMaterial"), /options\.uvGutter === true && options\.uvOccupancyTexture \? 1 : 0/);
  assert.match(dilationMaterialBody, /transparent: true/);
  assert.match(dilationMaterialBody, /blending: THREE\.NoBlending/);
});

test("TSL surface airbrush prewarms the same seam-bleed live source raster", () => {
  const body = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  assert.match(body, /const layerCoordinateReferenceTexture = layerMode[\s\S]*?layerBaseTexture \|\| materialOriginalMap \|\| material\.map \|\| editable\.texture/);
  assert.match(body, /ensureSurfaceAirbrushCache\(editor, editable, coordinateReferenceTexture \|\| referenceTexture, width, height\)/);
  assert.match(body, /const prewarmBaseTexture = layerSourceEmpty[\s\S]*?surfaceAirbrushTransparentTexture\(\)[\s\S]*?: sourceTexture/);
  assert.match(body, /const prewarmWritable = surfacePrewarmWritableTarget\([\s\S]*?cache,[\s\S]*?prewarmBaseTexture,[\s\S]*?coordinateReferenceTexture \|\| referenceTexture \|\| prewarmBaseTexture,[\s\S]*?width,[\s\S]*?height[\s\S]*?\)/);
  assert.match(body, /const prewarmTargetIndex = prewarmWritable\.targetIndex/);
  assert.match(body, /const prewarmTarget = prewarmWritable\.target/);
  assert.match(body, /const prewarmWriteTexture = prewarmTarget\?\.texture \|\| prewarmBaseTexture/);
  assert.match(body, /const prewarmStrokeMask = surfacePrewarmStrokeMaskTarget\(cache, width, height\)/);
  assert.match(body, /const prewarmStrokeMaskTarget = prewarmStrokeMask\.target/);
  assert.match(body, /const prewarmRasterWriteTexture = prewarmStrokeMaskTarget\?\.texture \|\| prewarmWriteTexture/);
  assert.match(body, /const usePrewarmSourceRasterClip = surfaceAirbrushSourceRasterClipEnabled\(\)/);
  assert.match(body, /const prewarmRasterClipPath = usePrewarmSourceRasterClip[\s\S]*?\? simplifiedSourceRasterClipSegments\(prewarmSegments, MAX_TSL_SURFACE_SEGMENTS\)[\s\S]*?: \[\]/);
  assert.match(body, /ensureUvOccupancyMask\([\s\S]*?prewarmRasterWriteTexture,[\s\S]*?width,[\s\S]*?height/);
  assert.match(body, /const prewarmOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled\(\)/);
  assert.match(body, /ensureUvRasterMeshes\([\s\S]*?prewarmBaseTexture,[\s\S]*?\{\s*\.\.\.materialScopeOptions,[\s\S]*?originalMeshUvRaster: prewarmOriginalMeshUvRaster,[\s\S]*?sourceRasterGutterPixels: surfaceAirbrushSourceRasterGutterPixels\(\),[\s\S]*?sourceRasterClipSegments: prewarmRasterClipPath,[\s\S]*?sourceRasterClipRequired: usePrewarmSourceRasterClip,[\s\S]*?sourceRasterClipHardness: finiteNumber\(options\.hardness,[\s\S]*?maskOnly: true,[\s\S]*?sourceRasterClipPaddingPixels: Math\.max\([\s\S]*?writeTexture: prewarmRasterWriteTexture,[\s\S]*?sampleTexture: prewarmBaseTexture[\s\S]*?\}/);
  assert.match(body, /clearSurfaceMaskTarget\(renderer, strokeMaskTarget\)/);
  assert.match(body, /renderSurfaceStrokeComposite\([\s\S]*?prewarmTarget,[\s\S]*?prewarmBaseTexture,[\s\S]*?strokeMaskTarget\.texture/);
  const prewarmMaskBlockStart = body.indexOf("const prewarmStrokeMask = surfacePrewarmStrokeMaskTarget");
  const prewarmMaskBlockEnd = body.lastIndexOf("const meshUvTriangleCount");
  assert.notEqual(prewarmMaskBlockStart, -1);
  assert.notEqual(prewarmMaskBlockEnd, -1);
  const prewarmMaskBlock = body.slice(prewarmMaskBlockStart, prewarmMaskBlockEnd);
  assert.match(prewarmMaskBlock, /if \(prewarmStrokeMask\.primesLiveTarget\) \{[\s\S]*?cache\.strokeMaskInitialized = false/);
  assert.match(body, /sourceRasterClipSegments: prewarmRasterClipPath/);
  assert.match(body, /const warmUvOccupancy = options\.warmUvOccupancy === true/);
  assert.match(body, /const uvOccupancyTexture = compileOnly && !warmUvOccupancy[\s\S]*?\? surfaceAirbrushWhiteMaskTexture\(\)[\s\S]*?: ensureUvOccupancyMask\(/);
  assert.match(body, /uvOccupancyWarmed: warmUvOccupancy/);
  const writableTargetBody = functionSource("surfacePrewarmWritableTarget");
  assert.match(writableTargetBody, /target: ensureSurfacePrewarmTarget\(cache, width, height, referenceTexture \|\| baseTexture\)/);
  assert.match(writableTargetBody, /targetIndex: -1/);
  assert.doesNotMatch(writableTargetBody, /cache\?\.targets/);
  const writableMaskBody = functionSource("surfacePrewarmStrokeMaskTarget");
  assert.match(writableMaskBody, /target: ensureSurfacePrewarmStrokeMaskTarget\(cache, width, height\),[\s\S]*?primesLiveTarget: false/);
  assert.doesNotMatch(writableMaskBody, /ensureSurfaceStrokeMaskTarget/);
  const prewarmMaskBody = functionSource("ensureSurfacePrewarmStrokeMaskTarget");
  assert.match(prewarmMaskBody, /cache\.prewarmStrokeMaskTarget/);
  assert.match(prewarmMaskBody, /texture-paint-tsl-surface-airbrush-prewarm-stroke-mask/);
  assert.doesNotMatch(prewarmMaskBody, /strokeMaskInitialized/);
  const prewarmTargetBody = functionSource("ensureSurfacePrewarmTarget");
  assert.match(prewarmTargetBody, /cache\.prewarmTarget/);
  assert.match(prewarmTargetBody, /texture-paint-tsl-surface-airbrush-prewarm/);
  const prewarmDisplayBody = functionSource("ensureSurfacePrewarmDisplayTarget");
  assert.match(prewarmDisplayBody, /cache\.prewarmDisplayTarget/);
  assert.match(prewarmDisplayBody, /texture-paint-tsl-surface-airbrush-prewarm-display/);
  assert.match(body, /const prewarmDisplayTarget = ensureSurfacePrewarmDisplayTarget\(/);
  assert.match(body, /schedulePrewarmCompilePass\([\s\S]*?cache\.copyScene,[\s\S]*?cache\.camera,[\s\S]*?prewarmDisplayTarget,[\s\S]*?"prewarm-display-copy"/);
  assert.match(body, /target: prewarmDisplayTarget/);
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(runBody, /const useOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled\(\)/);
  assert.match(runBody, /const rasterGutterScale = Math\.min\([\s\S]*?rasterWriteSize\.width \/ Math\.max\(1, width\)[\s\S]*?rasterWriteSize\.height \/ Math\.max\(1, height\)/);
  assert.match(runBody, /const sourceRasterGutterPixels = useStrokeMaskComposite[\s\S]*?Math\.ceil\(surfaceAirbrushSourceRasterGutterPixels\(\) \* rasterGutterScale\)[\s\S]*?: surfaceAirbrushSourceRasterGutterPixels\(\)/);
  assert.match(runBody, /sourceRasterGutterPixels,/);
});

test("TSL surface display targets are isolated from prewarm and previous material displays", () => {
  const displayBody = functionSource("ensureSurfaceDisplayTarget");
  const renderDisplayBody = functionSource("renderSurfaceDisplayTexture");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(displayBody, /const avoidTextures = new Set/);
  assert.match(displayBody, /cache\.displayTargets \|\|= \[\]/);
  assert.match(displayBody, /!avoidTextures\.has\(candidate\.texture\)/);
  assert.match(displayBody, /target\.texture\.flipY = referenceTexture\?\.flipY === true/);
  assert.match(renderDisplayBody, /options\.target \|\| ensureSurfaceDisplayTarget/);
  assert.match(renderDisplayBody, /avoidTextures: options\.avoidTextures/);
  assert.match(renderDisplayBody, /target\.texture\.flipY = referenceTexture\?\.flipY === true/);
  assert.match(runBody, /avoidTextures: \[previousMaterialMap\]/);
});

test("TSL surface render targets preserve layer alpha", () => {
  const body = functionSource("createRenderTarget");
  assert.match(body, /format: THREE\.RGBAFormat/);
  assert.match(body, /target\.texture\.format = THREE\.RGBAFormat/);
});

test("TSL layer airbrush keeps empty layer writes in base texture coordinates", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const baseBody = functionSource("surfaceLayerBaseTexture");
  const bindMatchingBody = functionSource("bindSurfaceTextureToMatchingMaterials");
  const compositeBody = functionSource("createLayerCompositeMaterial");
  const updateCompositeBody = functionSource("updateLayerCompositeMaterial");
  assert.match(body, /const layerCoordinateReferenceTexture = layerMode[\s\S]*?layerBaseTexture \|\| materialOriginalMap \|\| material\.map \|\| editable\.texture/);
  assert.match(body, /let coordinateReferenceTexture = layerMode[\s\S]*?\(layerCoordinateReferenceTexture \|\| referenceTexture\)/);
  assert.match(body, /ensureSurfaceAirbrushCache\(editor, editable, coordinateReferenceTexture \|\| referenceTexture, width, height\)/);
  assert.match(body, /cache\.strokeBaseTexture = freezeLiveStrokeBase[\s\S]*?ensureSurfaceStrokeBaseTexture\([\s\S]*?coordinateReferenceTexture \|\| referenceTexture \|\| sourceTexture[\s\S]*?: surfaceStrokeStartBaseTexture\(cache, sourceTexture\)/);
  assert.match(body, /texturePaintTslSurfaceDisplayFlipY = \(coordinateReferenceTexture \|\| referenceTexture\)\?\.flipY === true/);
  assert.match(body, /renderSurfaceLayerComposite\([\s\S]*?displayBaseTexture \|\| coordinateReferenceTexture \|\| referenceTexture/);
  assert.match(body, /renderSurfaceLayerComposite\([\s\S]*?\{ alphaFallback: false \}/);
  assert.match(bindMatchingBody, /allowImageMatch: options\.allowImageMatch === true/);
  assert.match(baseBody, /editable\?\.layerMode === true/);
  assert.match(baseBody, /const stableReferenceBase = \[[\s\S]*?userData\.textureAirbrushWebGpuCanvasMap,[\s\S]*?userData\.clonePaintOriginalMap,[\s\S]*?originalMap,[\s\S]*?material\?\.map[\s\S]*?surfaceLayerStableBaseCandidate/);
  assert.match(baseBody, /const clonePaintBase = surfaceLayerStableBaseCandidate\(material, editable, userData\.clonePaintTexture\)/);
  assert.match(baseBody, /const layerBase = stableReferenceBase[\s\S]*?\|\| clonePaintBase[\s\S]*?\|\| canvasBase/);
  assert.match(baseBody, /return layerBase \|\| null/);
  assert.match(compositeBody, /const alphaScale = uniform\(1, "float"\)/);
  assert.match(compositeBody, /const alphaFallback = uniform\(0, "float"\)/);
  assert.match(compositeBody, /const layerPresence = clamp\(max\(max\(layer\.r, layer\.g\), layer\.b\), 0\.0, 1\.0\)\.toVar\(\)/);
  assert.match(compositeBody, /const needsAlphaFallback = alphaFallback\.greaterThan\(0\.5\)[\s\S]*?\.and\(rawAlpha\.greaterThan\(0\.98\)\)/);
  assert.match(compositeBody, /const sourceAlpha = needsAlphaFallback[\s\S]*?\.select\(clamp\(layerPresence\.mul\(alphaScale\), 0\.0, 1\.0\), clamp\(layer\.a, 0\.0, 1\.0\)\)/);
  assert.match(compositeBody, /const alpha = clamp\(sourceAlpha\.mul\(opacity\), 0\.0, 1\.0\)\.toVar\(\)/);
  assert.match(compositeBody, /const layerRgb = sourceAlpha\.greaterThan\(0\.0001\)[\s\S]*?layer\.rgb\.div\(max\(sourceAlpha, 0\.0001\)\)/);
  assert.match(updateCompositeBody, /state\.alphaScale\.value = clamp01\(options\.alphaScale \?\? 1\)/);
  assert.match(updateCompositeBody, /state\.alphaFallback\.value = options\.alphaFallback === true \? 1 : 0/);
  assert.match(updateCompositeBody, /baseTexture\?\.userData\?\.texturePaintTslSurfaceAirbrushDisplayTexture === true/);
});

test("texture paint reset disposes layer GPU state and invalidates TSL surface cache", () => {
  const body = objectMethodSource(clonePaintSource, "resetEditableTexturePaintMaterial");
  assert.match(body, /const layerStack = userData\.texturePaintLayerStack \|\| null/);
  assert.match(body, /this\.textureAirbrushInvalidateWebGpuCache\?\.\(material\)/);
  assert.match(body, /this\.discardTexturePaintMaterialGpuComposite\?\.\(material\)/);
  assert.match(body, /for \(const layer of layerStack\?\.layers \|\| \[\]\)/);
  assert.match(body, /this\.disposeTexturePaintLayerGpuState\?\.\(layer\)/);
  assert.match(body, /delete userData\.texturePaintLayerStack/);
});

test("TSL pointer-down preserves prewarmed GPU state while targeted invalidation keeps static UV caches", () => {
  const cacheBody = functionSource("ensureSurfaceAirbrushCache");
  const resetBody = functionSource("resetSurfaceAirbrushDynamicState");
  const pointerDownBody = objectMethodSource(paintToolsSource, "onPointerDown");
  assert.match(cacheBody, /texturePaintTslSurfaceAirbrushInvalidate \|\|= \(editableOrTexture = null\) =>/);
  assert.match(cacheBody, /if \(!editableOrTexture\) \{[\s\S]*?for \(const candidateCache of editor\.texturePaintTslSurfaceAirbrushCacheSet \|\| \[\]\) \{[\s\S]*?resetSurfaceAirbrushDynamicState\(candidateCache\)/);
  assert.match(cacheBody, /const key = stableSurfaceAirbrushCacheKey\(editableOrTexture\)/);
  assert.match(cacheBody, /editableOrTexture\?\.layer\?\.canvas/);
  assert.match(cacheBody, /resetSurfaceAirbrushDynamicState\(candidateCache\)/);
  assert.match(cacheBody, /editableOrTexture\?\.isMaterial !== true/);
  assert.doesNotMatch(cacheBody, /texturePaintTslSurfaceAirbrushCacheSet\?\.clear\?\.\(\)/);
  assert.doesNotMatch(pointerDownBody, /this\.texturePaintTslSurfaceAirbrushInvalidate\?\.\(\)/);
  assert.match(pointerDownBody, /this\.texturePaintStrokePoint = null/);
  assert.match(pointerDownBody, /this\.textureAirbrushResetStrokeSpacing\?\.\(\)/);
  assert.match(resetBody, /cache\.currentTexture = null/);
  assert.match(resetBody, /cache\.strokeBaseTexture = null/);
  assert.match(resetBody, /cache\.strokeStyleKey = ""/);
  assert.match(resetBody, /cache\.strokeMaskInitialized = false/);
  assert.doesNotMatch(resetBody, /uvOccupancyKey/);
  assert.doesNotMatch(resetBody, /surfaceMeshes/);
  assert.doesNotMatch(resetBody, /disposeUvRasterEntries/);
});

test("TSL source-mesh raster caches are stable across ping-pong texture identities", () => {
  const rasterKeyBody = functionSource("sourceUvRasterGeometryKey");
  const occupancyKeyBody = functionSource("sourceUvOccupancyKey");
  const occupancyObjectKeyBody = functionSource("sourceObjectUvCoverageKey");
  const projectionFrameKeyBody = sourceFunction(projectionRecordSource, "surfaceProjectionFrameKey");
  assert.doesNotMatch(rasterKeyBody, /texture\?\.uuid \|\| texture\?\.id/);
  assert.doesNotMatch(occupancyKeyBody, /texture\?\.uuid \|\| texture\?\.id/);
  assert.match(rasterKeyBody, /writeTexture\?\.flipY === true \? "writeFlipY" : "writeNoFlipY"/);
  assert.match(rasterKeyBody, /sampleTexture\?\.flipY === true \? "sampleFlipY" : "sampleNoFlipY"/);
  assert.match(occupancyKeyBody, /texture\?\.flipY === true \? "flipY" : "noFlipY"/);
  assert.match(rasterKeyBody, /matrixSurfaceKey\(writeTexture\?\.matrix\)/);
  assert.match(rasterKeyBody, /matrixSurfaceKey\(sampleTexture\?\.matrix\)/);
  assert.match(occupancyKeyBody, /matrixSurfaceKey\(texture\?\.matrix\)/);
  assert.match(occupancyKeyBody, /sourceObjectUvCoverageKey\(sourceObject\)/);
  assert.doesNotMatch(occupancyKeyBody, /sourceObjectSurfaceProjectionKey\(sourceObject\)/);
  assert.match(occupancyObjectKeyBody, /geometry\?\.attributes\?\.uv\?\.version/);
  assert.match(occupancyObjectKeyBody, /maxGeometryGroupMaterialIndex\(geometry\)/);
  assert.doesNotMatch(occupancyObjectKeyBody, /matrixSurfaceKey/);
  assert.doesNotMatch(occupancyObjectKeyBody, /skeleton\?\.boneMatrices/);
  assert.doesNotMatch(occupancyObjectKeyBody, /morphTargetInfluences/);
  assert.doesNotMatch(projectionFrameKeyBody, /editor\?\.progress/);
  assert.doesNotMatch(projectionFrameKeyBody, /editor\?\.mixer\?\.time/);
  assert.doesNotMatch(projectionFrameKeyBody, /editor\?\.activeClipAction\?\.time/);
});

test("TSL source raster reuses component variants and filters before projection", () => {
  const ensureBody = functionSource("ensureSourceUvRasterGeometry");
  const rasterBody = functionSource("sourceUvRasterTriangles");
  const componentBody = functionSource("componentIdForTriangleVertices");
  const disposeBody = functionSource("disposeUvRasterEntry");
  assert.match(source, /const SOURCE_RASTER_GEOMETRY_MIN_TRIANGLES = 512/);
  assert.match(source, /const SOURCE_RASTER_GEOMETRY_CACHE_LIMIT = 8/);
  assert.match(ensureBody, /texturePaintTslSourceRasterGeometryVariants \|\|= new Map\(\)/);
  assert.match(ensureBody, /geometryVariants\.get\(key\)/);
  assert.match(ensureBody, /geometryVariants\.delete\(key\)[\s\S]*?geometryVariants\.set\(key, cachedVariant\)/);
  assert.match(ensureBody, /while \(geometryVariants\.size > SOURCE_RASTER_GEOMETRY_CACHE_LIMIT\)/);
  assert.match(ensureBody, /const transientGeometry = Boolean\([\s\S]*?sourceRasterTopologySeedVertices/);
  assert.match(ensureBody, /entry\.texturePaintTslTransientSourceRasterGeometry \|\| null/);
  assert.match(ensureBody, /transientVariant \|\| compileVariant \|\| createSourceRasterScratchGeometry\(\)/);
  assert.match(
    ensureBody,
    /if \(transientGeometry\) \{[\s\S]*?entry\.texturePaintTslTransientSourceRasterGeometry = geometry;[\s\S]*?return true;/
  );
  assert.match(ensureBody, /sourceRasterProjectionRecords: entry\.texturePaintTslSourceRasterProjectionRecords/);
  assert.match(rasterBody, /options\.sourceRasterProjectionRecords/);
  assert.ok(
    rasterBody.indexOf("sourceRasterTriangleAllowsComponent(componentId, options)")
      < rasterBody.indexOf("projectionRecordAt(ia)"),
    "component filtering should happen before vertex projection"
  );
  assert.doesNotMatch(componentBody, /new Map\(\)/);
  assert.match(disposeBody, /texturePaintTslSourceRasterGeometryVariants\?\.values\?\.\(\)/);
  assert.match(disposeBody, /entry\.texturePaintTslTransientSourceRasterGeometry/);
});

test("TSL live render-target display does not request a full atlas display copy", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(body, /liveDisplayTslRenderTarget: true/);
  assert.match(body, /liveDisplayFullUpdate: false/);
  assert.match(body, /liveDisplayWorkPixels: 0/);
  assert.match(body, /liveDisplayBounds: null/);
  assert.doesNotMatch(body, /liveDisplayWorkPixels: width \* height/);
});

test("TSL live queue accounting uses result work instead of full candidate estimate", () => {
  assert.match(liveSource, /function textureAirbrushWebGpuPaintResultWorkPixels/);
  assert.match(liveSource, /stats\?\.liveDisplayTslRenderTarget === true[\s\S]*?return 0/);
  assert.match(liveSource, /const resultEstimate = textureAirbrushWebGpuPaintResultWorkPixels\(result, candidate\.estimate \|\| 0\)/);
  assert.match(liveSource, /flushedWorkPixels \+= textureAirbrushWebGpuPaintResultWorkPixels/);
  assert.match(liveSource, /visiblePaintResultCount <= 0/);
  assert.doesNotMatch(liveSource, /estimate: candidate\.estimate \|\| 0/);
});

test("TSL projected gutter mesh only paints outside the original UV triangle", () => {
  const body = functionSource("createProjectedSurfaceMaterial");
  assert.match(body, /paintBarycentric\.assign\(attribute\("paintBarycentric", "vec3"\)\)/);
  assert.match(body, /projectedPaintGutterOnly/);
  assert.match(body, /insideOriginalTriangle/);
  assert.match(body, /insideOriginalTriangle\.select\(float\(0\), gatedCoverage\)/);
  assert.match(body, /select\(gutterCoverage, gatedCoverage\)/);
});

test("TSL projected triangle collection uses editable texture material scope", () => {
  const body = functionSource("meshUvProjectedTriangles");
  assert.match(body, /surfaceEditableTextureSet\(candidate, editable, texture/);
  assert.match(body, /sourceObjectMaterialPaintIndices/);
  assert.match(body, /paintMaterialIndices\.has\(geometryTriangleMaterialIndex\(geometry, elementStart\)\)/);
  assert.doesNotMatch(body, /geometryTriangleMaterialIndex\(geometry, elementStart\) !== materialIndex/);
});

test("TSL projected surface airbrush preserves opacity while filling projected gutters", () => {
  const body = functionSource("createProjectedSurfaceMaterial");
  assert.match(body, /const baseColor = sourceTextureNode\.toVar\(\)/);
  assert.match(body, /alpha\.lessThanEqual\(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD\)/);
  assert.match(body, /const gutterColor = vec4\(mix\(baseColor\.rgb, brushColor\.rgb, alpha\), 1\)/);
  assert.match(body, /const primaryColor = vec4\(mix\(baseColor\.rgb, brushColor\.rgb, alpha\), 1\)/);
  assert.match(body, /const emptyLayer = emptyLayerSource\.greaterThan\(0\.5\)\.toVar\(\)/);
  assert.match(body, /if \(layerOnly\) \{[\s\S]*?const paintColor = surfaceLayerPaintColor\(baseColor, brushColor, alpha, emptyLayer,[\s\S]*?basePremultiplied: false/);
  assert.match(body, /const eraseColor = surfaceLayerEraseColor\(baseColor, alpha,[\s\S]*?basePremultiplied: false/);
  assert.match(body, /return erasePaint\.greaterThan\(0\.5\)\.select\(eraseColor, paintColor\)/);
  assert.match(body, /return gutterOnly\.select\(gutterColor, primaryColor\)/);
  assert.match(body, /blendOnly,/);
  assert.match(body, /emptyLayerSource,/);
  assert.match(body, /layerOnly/);
  assert.match(body, /transparent: false/);
  assert.match(body, /blending: THREE\.NoBlending/);
  assert.doesNotMatch(body, /vec4\(brushColor\.rgb\.mul\(alpha\), alpha\)/);
});

test("TSL source-mesh airbrush only writes covered base-plus-brush texels", () => {
  const body = functionSource("createSurfaceMaterial");
  assert.match(body, /const baseColor = sourceTextureNode\.toVar\(\)/);
  assert.match(body, /const blendOnly = uniform\(0, "float"\)/);
  assert.match(body, /alpha\.lessThanEqual\(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD\)/);
  assert.match(body, /noCoverage\.discard\(\)/);
  assert.match(body, /const emptyLayer = emptyLayerSource\.greaterThan\(0\.5\)\.toVar\(\)/);
  assert.match(body, /if \(layerOnly\) \{[\s\S]*?const paintColor = surfaceLayerPaintColor\(baseColor, brushColor, alpha, emptyLayer,[\s\S]*?basePremultiplied: false/);
  assert.match(body, /const eraseColor = surfaceLayerEraseColor\(baseColor, alpha,[\s\S]*?basePremultiplied: false/);
  assert.match(body, /return erasePaint\.greaterThan\(0\.5\)\.select\(eraseColor, paintColor\)/);
  assert.match(body, /return vec4\(mix\(baseColor\.rgb, brushColor\.rgb, alpha\), 1\)/);
  assert.match(body, /transparent: maskOnly === true \|\| layerOnly/);
  assert.match(body, /blending: maskOnly \? THREE\.CustomBlending : THREE\.NoBlending/);
  assert.match(body, /surfaceScreen\.xy\.sub\(start\.xy\)/);
  assert.doesNotMatch(body, /surfaceScreen\.sub\(start\.xyz\)/);
  assert.doesNotMatch(body, /return vec4\(brushColor\.rgb, alpha\)/);
});

test("TSL live strokes use a max-blended stroke mask to cap opacity", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const materialBody = functionSource("updateSurfaceMaterial");
  const sourceMaterialBody = functionSource("createSurfaceMaterial");
  const compositeBody = functionSource("createStrokeCompositeMaterial");
  const compositeRunBody = functionSource("renderSurfaceStrokeComposite");
  assert.doesNotMatch(source, /MAX_TSL_SURFACE_STROKE_MASK_SIZE/);
  assert.match(source, /surfaceStrokeMaskSize\(width, height\)/);
  assert.match(body, /const blendOntoBaseTarget = false/);
  assert.match(body, /const useStrokeMaskComposite = !useProjectedPrimary[\s\S]*?debugParams\?\.has\("debugAirbrushDirectSurfaceComposite"\) !== true/);
  assert.doesNotMatch(body, /debugAirbrushStrokeMaskComposite/);
  assert.match(body, /const renderPaintSegments = useStrokeMaskComposite[\s\S]*?newlyAppendedPaintSegments[\s\S]*?: paintSegments/);
  assert.match(body, /const maskRenderBatches = useStrokeMaskComposite[\s\S]*?chunkSurfaceSegmentsForShader\(renderPaintSegments\)/);
  assert.match(body, /const shaderPaintSegments = useStrokeMaskComposite[\s\S]*?maskRenderBatches\[0\][\s\S]*?: renderPaintSegments/);
  assert.match(body, /filterProjectedTrianglesForScreenBrush\(rawProjectedTriangles, renderPaintSegments, options\)/);
  assert.match(body, /const emptyLayerSourceTexture = Boolean\(layerMode && baseTexture === surfaceAirbrushTransparentTexture\(\)\)/);
  assert.match(body, /blendOnly: layerMode,[\s\S]*?emptyLayerSource: emptyLayerSourceTexture,[\s\S]*?debugVisibleSurfaceDepth: needsVisibleSurfaceTexture/);
  assert.match(body, /updateSurfaceMaterial\([\s\S]*?shaderPaintSegments[\s\S]*?emptyLayerSource: emptyLayerSourceTexture/);
  assert.match(body, /ensureSurfaceStrokeMaskTarget\(cache, width, height\)/);
  assert.match(body, /clearSurfaceStrokeMaskTarget\(renderer, cache\)/);
  assert.match(body, /renderer\.setRenderTarget\(strokeMaskTarget\)/);
  assert.match(body, /for \(const batchSegments of maskRenderBatches\)/);
  assert.match(body, /updateSurfaceMaterial\([\s\S]*?batchSegments[\s\S]*?uvOccupancyTexture/);
  assert.match(body, /renderSurfaceStrokeComposite\([\s\S]*?baseTexture[\s\S]*?strokeMaskTarget\.texture/);
  assert.match(body, /const layerSourceEmpty = Boolean\(layerMode && surfaceLayerSourceIsEmpty\(editable\)\)/);
  assert.match(body, /cache\.strokeBaseTexture = surfaceAirbrushTransparentTexture\(\)/);
  assert.match(body, /copiedBaseTexture = transparentBaseTexture[\s\S]*?\? false[\s\S]*?: copySurfaceBaseTexture\(renderer, baseTexture, target, cache\)/);
  assert.match(body, /clearedTransparentBaseTexture = clearRenderTargetTransparent\(renderer, target, cache\)/);
  assert.match(body, /const freezeLiveStrokeBase = Boolean\(/);
  assert.doesNotMatch(body, /texturePaintTslSurfaceLastStrokeBaseCopy = "cache-ping-pong"/);
  assert.match(body, /texturePaintTslSurfaceLastStrokeBaseCopy = cache\.strokeBaseTexture === sourceTexture[\s\S]*?\? "direct-source"[\s\S]*?: "stable-source"/);
  assert.match(compositeRunBody, /const clearTransparentBase = options\.emptyLayerSource === true/);
  assert.match(compositeRunBody, /clearRenderTargetTransparent\(renderer, target, cache\)/);
  const compositeUpdateBody = functionSource("updateStrokeCompositeMaterial");
  assert.match(compositeUpdateBody, /baseTexture\?\.flipY === true && !surfaceAirbrushTextureIsLiveTarget\(baseTexture\)/);
  assert.match(compositeUpdateBody, /\|\| textureNodeAppliesFlipY\(baseTexture\)/);
  assert.doesNotMatch(body, /const renderPaintSegments = blendOntoBaseTarget \? segments : paintSegments/);
  assert.match(body, /tslSurfaceStrokeMask: useStrokeMaskComposite/);
  assert.match(body, /tslSurfaceBlendInPlace: blendOntoBaseTarget/);
  assert.match(body, /tslSurfaceAccumulatedPaintSegmentCount: paintSegments\.length/);
  assert.match(body, /tslSurfacePaintSegmentCount: renderPaintSegments\.length/);
  assert.match(body, /tslSurfaceShaderSegmentLimit: MAX_TSL_SURFACE_SEGMENTS/);
  assert.match(body, /tslSurfaceShaderBatchCount: useStrokeMaskComposite \? maskRenderBatches\.length : 1/);
  assert.match(sourceMaterialBody, /const maskOnly = options\.maskOnly === true/);
  assert.match(sourceMaterialBody, /const alpha = clamp\(opacity\.mul\(strength\)\.mul\(coverage\), 0\.0, 1\.0\)/);
  assert.match(sourceMaterialBody, /return vec4\(alpha, alpha, alpha, alpha\)/);
  assert.match(sourceMaterialBody, /blending: maskOnly \? THREE\.CustomBlending : THREE\.NoBlending/);
  assert.match(sourceMaterialBody, /material\.blendEquation = THREE\.MaxEquation/);
  assert.match(compositeBody, /const mask = maskTextureNode\.sample\(maskUv\)\.toVar\(\)/);
  assert.match(compositeBody, /const alpha = clamp\(mask\.a, 0\.0, 1\.0\)/);
  assert.match(compositeBody, /emptyLayer\.and\(alpha\.lessThanEqual\(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD\)\)\.discard\(\)/);
  assert.match(compositeBody, /if \(layerOnly\) \{[\s\S]*?const paintColor = surfaceLayerPaintColor\(baseColor, brushColor, alpha, emptyLayer,[\s\S]*?basePremultiplied: true/);
  assert.match(compositeBody, /const eraseColor = surfaceLayerEraseColor\(baseColor, alpha,[\s\S]*?basePremultiplied: true/);
  assert.match(compositeBody, /return erasePaint\.greaterThan\(0\.5\)\.select\(eraseColor, paintColor\)/);
  assert.doesNotMatch(compositeBody, /const alpha = clamp\(max\(max\(mask\.r, mask\.g\), mask\.a\), 0\.0, 1\.0\)/);
  assert.match(compositeBody, /transparent: true/);
  assert.match(compositeBody, /blending: layerOnly \? THREE\.NoBlending : THREE\.CustomBlending/);
  assert.match(compositeBody, /if \(!layerOnly\) \{/);
  assert.match(compositeBody, /material\.blendSrc = THREE\.OneFactor/);
  assert.match(compositeBody, /material\.blendDst = THREE\.ZeroFactor/);
  assert.match(compositeBody, /material\.blendSrcAlpha = THREE\.OneFactor/);
  assert.match(compositeBody, /material\.blendDstAlpha = THREE\.ZeroFactor/);
  assert.match(compositeBody, /return vec4\(mix\(baseColor\.rgb, brushColor\.rgb, alpha\), 1\)/);
  assert.match(materialBody, /const shaderSourceTexture = sourceTexture \|\| \(wantsBlendOnly[\s\S]*?surfaceAirbrushTransparentTexture\(\)[\s\S]*?: surfaceAirbrushWhiteMaskTexture\(\)\)/);
  assert.match(materialBody, /const shaderVisibleTexture = visibleTexture \|\| shaderSourceTexture/);
  assert.match(materialBody, /state\.sourceTextureNode\.value = shaderSourceTexture/);
  assert.match(materialBody, /state\.blendOnly\.value = wantsBlendOnly \? 1 : 0/);
  assert.match(materialBody, /state\.erasePaint\.value = options\.erase === true \? 1 : 0/);
  assert.match(materialBody, /state\.emptyLayerSource\.value = options\.emptyLayerSource === true \? 1 : 0/);
  assert.match(materialBody, /state\.maskOnly === true[\s\S]*?material\.blending !== THREE\.CustomBlending/);
});

test("TSL full-surface mode skips projected triangle collection for live source raster", () => {
  const start = strokeSource.indexOf("const preferTslFullSurfaceUvRaster = options.liveProjectedPaint === true");
  assert.notEqual(start, -1, "preferTslFullSurfaceUvRaster condition should exist");
  const body = strokeSource.slice(start, strokeSource.indexOf("const currentTriangle", start));
  assert.doesNotMatch(body, /visibleEdgeMode/);
  assert.match(strokeSource, /const preferTslSurfaceProjectedPrimary = options\.useTslSurfaceAirbrush !== false[\s\S]*?&& options\.projectedPrimary === true/);
  assert.match(strokeSource, /const projectedRenderTriangles = usesScreenProjectedVisibility[\s\S]*?&& !preferTslFullSurfaceUvRaster[\s\S]*?&& !preferTslSurfaceProjectedPrimary[\s\S]*?\?/);
  assert.doesNotMatch(strokeSource, /preferTslFullSurfaceUvRaster\s+\?\s+Math\.max\(256, Math\.min\(4096/);
  assert.match(strokeSource, /fullProjectedSurfaceRenderTriangles: !preferTslFullSurfaceUvRaster/);
  assert.match(strokeSource, /preferTslSurfaceProjectedPrimary && visibilityTriangles\.length \? \{ projectedPrimary: true \} : \{\}/);
});

test("TSL live surface airbrush skips redundant projected texture segment generation", () => {
  const start = strokeSource.indexOf("const skipProjectedSeamStrokeSegmentsForTslSurface = options.collectProjectedSeamStrokeSegments !== true");
  assert.notEqual(start, -1, "TSL seam projection skip should exist");
  const body = strokeSource.slice(start, strokeSource.indexOf("const seamProjectedStrokeSegments", start));
  assert.match(body, /options\.useTslSurfaceAirbrush !== false/);
  assert.match(body, /options\.liveProjectedPaint === true/);
  assert.match(body, /editor\?\.renderer\?\.isWebGPURenderer === true/);
  assert.doesNotMatch(body, /options\.neighborPaintSeed\?\.enabled !== true/);
  assert.doesNotMatch(body, /options\.largeLiveNeighborPaint !== true/);
  assert.match(body, /options\.requireVisibilityTriangles === true && options\.neighborPaintSeed\?\.enabled === true/);
  assert.match(body, /options\.requireVisibilityTriangles === true && options\.largeLiveNeighborPaint === true/);
  assert.match(body, /const collectProjectedSeamStrokeSegments = !skipProjectedSeamStrokeSegmentsForTslSurface/);
});

test("TSL immediate screen strokes render split descriptors during live drag", () => {
  const start = liveSource.indexOf("const runSplitPaintDescriptors = () => {");
  assert.notEqual(start, -1, "split paint descriptor runner should exist");
  const body = liveSource.slice(start, liveSource.indexOf("const executePaintRuns", start));
  assert.match(body, /const deferRemainingScreenSplitDescriptors = options\.immediateWebGpuFlush === true\s*\n\s*&& paintRunDescriptors\.length > 1\s*\n\s*&& !useTslSurfaceAirbrush/);
});

test("TSL surface airbrush is used for early projected live samples once screen segments exist", () => {
  const start = liveSource.indexOf("const useTslSurfaceAirbrush = projectedLivePaint === true");
  assert.notEqual(start, -1, "useTslSurfaceAirbrush condition should exist");
  const body = liveSource.slice(start, liveSource.indexOf("const debugRoot", start));
  assert.match(body, /canUseTslSurfaceAirbrush/);
  assert.doesNotMatch(body, /&& hasFullProjectedSurfaceData/);
  assert.doesNotMatch(body, /visibleEdgeMode\s*!==\s*"hard"/);
});

test("TSL surface descriptor is used for hard and soft full-surface live paint", () => {
  const start = liveSource.indexOf("const preferTslSurfaceAirbrushDescriptor = projectedLivePaint === true");
  assert.notEqual(start, -1, "preferTslSurfaceAirbrushDescriptor condition should exist");
  const body = liveSource.slice(start, liveSource.indexOf("const hasExplicitCandidatePaintRegions", start));
  assert.match(body, /hasScopedProjectedPrimaryTriangles/);
  assert.match(body, /fullProjectedSurfacePaint === true/);
  assert.match(body, /\(fullProjectedSurfacePaint === true \|\| hasScopedProjectedPrimaryTriangles\)/);
  assert.match(body, /texturePaintCanUseTslSurfaceAirbrush/);
  assert.doesNotMatch(body, /visibleEdgeModeForSurfaceTsl/);
  assert.doesNotMatch(body, /visibleEdgeMode\s*!==\s*"hard"/);
  assert.doesNotMatch(body, /visibleEdgeModeForSurfaceTsl\s*!==\s*"hard"/);
});

test("TSL layer-mode strokes stay on the active paint layer GPU target", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(body, /const layerMode = editable\?\.layerMode === true && editable\?\.layer/);
  assert.match(body, /surfaceLayerSourceTexture\(editable/);
  assert.match(body, /bindSurfaceLayerTarget\(editor, material, editable, finalTarget/);
  assert.match(body, /material\.userData\.texturePaintCompositeGpuTarget = \{/);
  assert.match(body, /tslSurfaceLayerMode: Boolean\(layerMode\)/);
  assert.match(body, /tslSurfaceLayerTarget: Boolean\(layerTargetEntry\?\.target\?\.texture\)/);
  assert.match(body, /tslSurfaceLayerDisplayComposite: Boolean\(layerDisplayTarget\?\.texture\)/);
});

test("TSL layer-mode live display keeps lower layer composites as underlays", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const prewarmBody = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  const underlayBody = functionSource("surfaceLayerDisplayUnderlayTexture");
  const avoidBody = functionSource("surfaceLayerCompositeAvoidTextures");
  const targetBody = functionSource("ensureSurfaceLayerCompositeTarget");
  const compositeBody = functionSource("renderSurfaceLayerComposite");
  assert.match(body, /surfaceLayerDisplayUnderlayTexture\(/);
  assert.match(body, /layerTargetEntry\.liveCompositeBaseTexture = layerDisplayBaseTexture/);
  assert.match(body, /layerTargetEntry\.liveCompositeLayerMutationSerial = surfaceLayerMutationSerial\(editor\)/);
  assert.match(body, /tslSurfaceLayerDisplayUsedLiveUnderlay: layerDisplayUsedLiveUnderlay/);
  assert.match(underlayBody, /surfaceLayerStoredUnderlayTexture\(editor, editable\)/);
  assert.match(underlayBody, /surfaceLayerCompositeIsBelowActive\(compositeEntry, editable\)/);
  assert.match(underlayBody, /surfaceLayerBaseTexture\(editor, material, editable, originalMap\)/);
  assert.match(targetBody, /const avoidTextures = new Set/);
  assert.match(targetBody, /cache\.layerCompositeTargets \|\|= \[\]/);
  assert.match(targetBody, /!avoidTextures\.has\(candidate\.texture\)/);
  assert.match(source, /const MAX_TSL_SURFACE_LAYER_COMPOSITE_TARGETS = 4/);
  assert.match(targetBody, /targets\.length < MAX_TSL_SURFACE_LAYER_COMPOSITE_TARGETS/);
  assert.match(targetBody, /const reusableIndex = targets\.findIndex\(\(candidate\) => candidate\?\.texture && !avoidTextures\.has\(candidate\.texture\)\)/);
  assert.doesNotMatch(targetBody, /targets\.find\(\(candidate\) => candidate\?\.texture\) \|\| null/);
  assert.match(compositeBody, /avoidTextures: \[[\s\S]*?baseTexture,[\s\S]*?layerTexture,[\s\S]*?\.\.\.\(Array\.isArray\(options\.avoidTextures\) \? options\.avoidTextures : \[\]\)/);
  assert.match(prewarmBody, /const prewarmLayerDisplayBaseTexture = surfaceLayerDisplayUnderlayTexture\(/);
  assert.match(prewarmBody, /prewarmLayerDisplayBaseTexture \|\| layerBaseTexture \|\| coordinateReferenceTexture \|\| referenceTexture/);
  assert.match(prewarmBody, /avoidTextures: surfaceLayerCompositeAvoidTextures\(material, editable\)/);
  assert.match(avoidBody, /addTexture\(material\?\.map \|\| null\)/);
  assert.match(avoidBody, /materialUserData\.texturePaintCompositeGpuTarget/);
  assert.match(avoidBody, /materialUserData\.texturePaintTslSurfaceAirbrushTarget/);
  assert.match(avoidBody, /for \(const layer of stack\?\.layers \|\| \[\]\)/);
  assert.match(avoidBody, /addTarget\(entry\?\.displayTarget \|\| null\)/);
  assert.match(avoidBody, /addTarget\(entry\?\.liveCompositeTarget \|\| null\)/);
});

test("TSL surface brush coverage applies component metadata only when enabled", () => {
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  const surfaceBody = functionSource("createSurfaceMaterial");
  for (const materialBody of [projectedBody, surfaceBody]) {
    assert.match(materialBody, /const segmentComponents = uniformArray/);
    assert.match(materialBody, /const componentGateEnabled = uniform\(0, "float"\)/);
    assert.match(materialBody, /const componentGateFrontmostRelax = uniform\(0, "float"\)/);
    assert.match(materialBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
    assert.match(materialBody, /const segmentComponent = segmentComponents\.element\(i\)/);
    assert.match(materialBody, /const connectedComponentGate =/);
    assert.match(materialBody, /const strictComponentGate = componentGateActive[\s\S]*?\.select\(connectedComponentGate\.select\(float\(1\), float\(0\)\), float\(1\)\)/);
    assert.match(materialBody, /const componentGateRelaxAuthority = frontmostSurfaceLocalityAuthority[\s\S]*?\.mul\(componentGateFrontmostRelax\)[\s\S]*?\.toVar\(\)/);
    assert.match(materialBody, /const componentGate = mix\([\s\S]*?strictComponentGate,[\s\S]*?float\(1\),[\s\S]*?componentGateRelaxAuthority[\s\S]*?\)\.toVar\(\)/);
    assert.match(materialBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentGate\)/);
    assert.match(materialBody, /\.mul\(normalGate\)/);
    assert.doesNotMatch(materialBody, /visibleGateCoverage/);
    assert.doesNotMatch(materialBody, /const surfaceFieldCoverage = brushFieldCoverage\.[^\n]*\.mul\(componentGate\)/);
  }
  assert.match(functionSource("sourceRasterClipComponentGateEnabled"), /debugAirbrushNoComponentGate/);
  assert.match(functionSource("updateSurfaceMaterial"), /const componentGateEnabled = sourceRasterClipComponentGateEnabled\(options\)/);
  assert.match(functionSource("updateSurfaceMaterial"), /state\.componentGateEnabled\.value = componentGateEnabled \? 1 : 0/);
  assert.match(functionSource("updateSurfaceMaterial"), /state\.componentGateFrontmostRelax\.value = options\.relaxComponentGateOnFrontmost === true \? 1 : 0/);
  assert.match(functionSource("texturePaintRunTslSurfaceAirbrush"), /relaxComponentGateOnFrontmost: options\.relaxComponentGateOnFrontmost === true/);
  assert.match(functionSource("texturePaintRunTslSurfaceAirbrush"), /tslSurfaceComponentGateFrontmostRelax: sourceRasterOptions\.relaxComponentGateOnFrontmost === true/);
  assert.match(functionSource("exposeSurfaceRunDebug"), /componentGateFrontmostRelax: stats\.tslSurfaceComponentGateFrontmostRelax === true/);
});

test("TSL surface airbrush uses visible-depth data only as a frontmost surface gate", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const materialBody = functionSource("createSurfaceMaterial");
  const updateBody = functionSource("updateSurfaceMaterial");
  assert.match(body, /const needsVisibleSurfaceTexture = debugParams\?\.has\("debugAirbrushNoVisibleSurface"\) !== true[\s\S]*?&& sourceObjects\.length > 0/);
  assert.doesNotMatch(body, /const needsVisibleSurfaceTexture = !useProjectedPrimary/);
  assert.match(body, /renderVisibleSurfaceTarget\(/);
  assert.match(updateBody, /state\.visibleSurfaceEnabled\.value = options\.debugVisibleSurfaceDepth === true && visibleTexture \? 1 : 0/);
  assert.match(updateBody, /state\.visibleNormalEdge\.value = debugParams\?\.has\("debugAirbrushNoNormalGate"\) === true[\s\S]*?\? 0[\s\S]*?: visibleEdgeMode === "hard" \|\| visibleEdgeMode === "soft" \? 1 : 0/);
  assert.match(body, /debugVisibleSurfaceDepth: needsVisibleSurfaceTexture/);
  assert.doesNotMatch(materialBody, /visibilityCoverage|visibleDepthFade|visibleDepthSmoothFade/);
  assert.doesNotMatch(materialBody, /visibleGateCoverage/);
  assert.match(materialBody, /const screenCoverage = edgeCoverage\.toVar\(\)/);
  assert.match(materialBody, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /const surfaceCoverage =/);
  assert.doesNotMatch(materialBody, /screenGate/);
  assert.doesNotMatch(materialBody, /surfaceCoverage\.mul\(screenGate\)/);
  assert.doesNotMatch(materialBody, /visibleDepthGate|visibleBehindDepth/);
  assert.doesNotMatch(materialBody, /viewContinuityCoverage|viewContinuityFade|viewContinuitySmoothFade/);
  assert.match(materialBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(visibilityCoverage\)/);
  assert.doesNotMatch(materialBody, /const surfaceFieldCoverage = brushFieldCoverage\.mul\(depthGate\)/);
  assert.match(materialBody, /const frontmostSurfaceHardCoverage = visibleDepthDelta[\s\S]*?lessThanEqual\(VISIBLE_SURFACE_OCCLUSION_DEPTH_TOLERANCE\)[\s\S]*?\.toVar\(\)/);
  assert.match(materialBody, /const frontmostSurfaceSoftRamp = clamp\([\s\S]*?VISIBLE_SURFACE_OCCLUSION_DEPTH_SOFT_FEATHER[\s\S]*?\.toVar\(\)/);
  assert.match(materialBody, /const frontmostSurfaceCoverage = mix\([\s\S]*?frontmostSurfaceSoftCoverage,[\s\S]*?frontmostSurfaceHardCoverage,[\s\S]*?hardVisibleEdge[\s\S]*?\)\.toVar\(\)/);
  assert.match(materialBody, /const closerDepthRamp = clamp\([\s\S]*?visibleDepthDelta\.mul\(-1\)[\s\S]*?VISIBLE_SURFACE_CLOSER_DEPTH_TOLERANCE[\s\S]*?VISIBLE_SURFACE_CLOSER_DEPTH_FEATHER[\s\S]*?\.toVar\(\)/);
  assert.match(materialBody, /const visibleDepthCoverageBase = frontmostSurfaceCoverage\.mul\(closerDepthCoverage\)\.toVar\(\)/);
  assert.match(materialBody, /const visibleSoftEdgeCoverageForOffset = \(offset\) => max\([\s\S]*?visibleTextureNode\.sample[\s\S]*?vec2\(offset\.x, 0\)[\s\S]*?vec2\(0, offset\.y\)[\s\S]*?\);/);
  assert.match(materialBody, /const visibleSoftEdgeCoverage = max\([\s\S]*?VISIBLE_SURFACE_SOFT_EDGE_COVERAGE[\s\S]*?VISIBLE_SURFACE_SOFT_EDGE_FAR_COVERAGE[\s\S]*?float\(1\)\.sub\(hardVisibleEdge\)[\s\S]*?\.toVar\(\)/);
  assert.match(materialBody, /const visibleDepthCoverage = max\([\s\S]*?visibleDepthCoverageBase,[\s\S]*?visibleSoftEdgeCoverage\.mul\(visibleSampleValid\)[\s\S]*?\)\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /const visibleDepthCoverage = max\(visibleDepthCoverageBase, visibleSoftEdgeCoverage\)\.toVar\(\)/);
  assert.match(materialBody, /const depthGate = mix\(float\(1\), visibleDepthCoverage, visibleActive\)\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /depthGate = mix\(float\(1\), visibleDepthCoverage, visibleActive\.mul\(visibleSampleValid\)\)/);
  assert.doesNotMatch(materialBody, /occlusionDepthRamp|occlusionDepthCoverage|depthGateWeight|depthGateInfluence|behindVisibleSurface/);
  assert.doesNotMatch(materialBody, /const surfaceFieldCoverage = brushFieldCoverage[\s\S]*?\.mul\(hasViewGate\.select\(viewCoverage, float\(1\)\)\)/);
  assert.match(materialBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthGate\)[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /visiblePermission|visibleSoftPermission/);
  assert.doesNotMatch(materialBody, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.doesNotMatch(materialBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(materialBody, /bridgePermission/);
  assert.match(materialBody, /const normalGate = mix\(float\(1\), facingCoverage, visibleNormalEdge\)\.toVar\(\)/);
  assert.match(materialBody, /const facingCoverage = mix\(softFacingCoverage, hardFacingCoverage, hardVisibleEdge\)\.toVar\(\)/);
  assert.doesNotMatch(source, /VISIBLE_SURFACE_DEPTH_GATE_/);
  assert.doesNotMatch(materialBody, /visibleRadius/);
  assert.doesNotMatch(materialBody, /viewRadius\.mul\(float\(0\.85\)/);
});

test("TSL surface airbrush visible-depth prepass uses all visible source objects for occlusion", () => {
  const body = functionSource("ensureVisibleSurfaceResources");
  const visibleSourceBody = functionSource("sourceObjectsForVisibleOcclusion");
  const visibleAddBody = functionSource("addUniqueVisibleOcclusionObject");
  const objectVisibleBody = functionSource("objectVisibleInScene");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  const prewarmBody = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  const materialBody = functionSource("createVisibleSurfaceMaterial");
  assert.match(body, /surfaceRasterMaterialsForSourceObject/);
  assert.match(body, /cache\.visibleMaterial/);
  assert.match(source, /function sourceObjectsForVisibleOcclusion/);
  assert.match(visibleSourceBody, /editor\?\.model\?\.traverse\?\.\(\(node\) =>/);
  assert.match(visibleSourceBody, /addUniqueVisibleOcclusionObject\(output, seen, node\)/);
  assert.match(visibleAddBody, /geometry\?\.attributes\?\.position/);
  assert.doesNotMatch(visibleAddBody, /attributes\?\.uv/);
  assert.match(objectVisibleBody, /current\.visible === false/);
  assert.match(runBody, /const visibleOcclusionSourceObjects = sourceObjectsForVisibleOcclusion\(editor, candidate\)/);
  assert.match(runBody, /const visibleOcclusionScopeOptions = \{ includeAllMaterialIndices: true \}/);
  assert.match(runBody, /renderVisibleSurfaceTarget\([\s\S]*?visibleOcclusionSourceObjects\.length \? visibleOcclusionSourceObjects : sourceObjects,[\s\S]*?editor,[\s\S]*?null,[\s\S]*?new Set\(\),[\s\S]*?sourceObject,[\s\S]*?materialIndex,[\s\S]*?visibleOcclusionScopeOptions[\s\S]*?\)/);
  assert.match(prewarmBody, /const visibleOcclusionSourceObjects = sourceObjectsForVisibleOcclusion\(editor, candidate\)/);
  assert.match(prewarmBody, /const visibleOcclusionScopeOptions = \{ includeAllMaterialIndices: true \}/);
  assert.match(prewarmBody, /renderVisibleSurfaceTarget\([\s\S]*?visibleOcclusionSourceObjects\.length \? visibleOcclusionSourceObjects : sourceObjects,[\s\S]*?editor,[\s\S]*?null,[\s\S]*?new Set\(\),[\s\S]*?sourceObject,[\s\S]*?materialIndex,[\s\S]*?visibleOcclusionScopeOptions[\s\S]*?\)/);
  assert.match(runBody, /ensureUvOccupancyMask\([\s\S]*?sourceObjects,[\s\S]*?editable,[\s\S]*?editableTextures,[\s\S]*?sourceObject,[\s\S]*?materialIndex,[\s\S]*?materialScopeOptions[\s\S]*?\)/);
  assert.match(runBody, /ensureUvRasterMeshes\([\s\S]*?sourceObjects,[\s\S]*?editable,[\s\S]*?editableTextures,[\s\S]*?sourceObject,[\s\S]*?materialIndex,[\s\S]*?sourceRasterOptions[\s\S]*?\)/);
  assert.match(body, /sourceObject === fallbackSourceObject \? fallbackMaterialIndex : null/);
  assert.match(materialBody, /normalView/);
  assert.match(materialBody, /floor/);
  assert.match(materialBody, /const visibleDepth = positionView\.z\.mul\(-1\)\.toVar\(\)/);
  assert.match(materialBody, /const visibleDepthBase = floor\(visibleDepth\)\.toVar\(\)/);
  assert.match(materialBody, /const visibleDepthRemainder = visibleDepth\.sub\(visibleDepthBase\)\.toVar\(\)/);
  assert.match(materialBody, /const encodedNormalZ = clamp\(normalView\.z\.mul\(0\.5\)\.add\(0\.5\), 0\.0, 1\.0\)\.toVar\(\)/);
  assert.match(materialBody, /vec4\(visibleDepthBase, encodedNormalZ, visibleDepthRemainder, 1\)/);
  assert.match(functionSource("createProjectedSurfaceMaterial"), /const visibleDepth = visibleSample\.r\.add\(visibleSample\.b\)\.toVar\(\)/);
  assert.match(functionSource("createSurfaceMaterial"), /const visibleDepth = visibleSample\.r\.add\(visibleSample\.b\)\.toVar\(\)/);
});

test("TSL original-mesh UV raster evaluates normals in the editor camera view", () => {
  const body = functionSource("createSurfaceMaterial");
  const updateBody = functionSource("updateSurfaceMaterial");
  const projectionBody = sourceFunction(projectionRecordSource, "ensureSurfaceProjectionAttributes");
  const meshBody = functionSource("ensureUvRasterMeshes");
  const originalMeshBranch = body.slice(body.indexOf("if (originalMeshUvRaster)"));
  const originalMeshOnlyBranch = originalMeshBranch.slice(
    0,
    originalMeshBranch.indexOf('paintUv.assign(attribute("sourceUv", "vec2"))')
  );
  assert.match(body, /normalWorldGeometry/);
  assert.match(body, /originalMeshUvRaster,/);
  assert.match(updateBody, /state\.sourceSampleFlipY\.value = state\.originalMeshUvRaster === true[\s\S]*?\? 0[\s\S]*?: textureNodeAppliesFlipY\(shaderSourceTexture\) \? 1 : 0/);
  assert.match(projectionBody, /rasterGeometry\.setAttribute\("paintView", viewAttribute\)/);
  assert.match(projectionBody, /rasterGeometry\.setAttribute\("paintScreen", screenAttribute\)/);
  assert.match(projectionBody, /rasterGeometry\.setAttribute\("paintNormal", normalAttribute\)/);
  assert.doesNotMatch(projectionBody, /rasterGeometry\.setAttribute\("paintComponent"/);
  assert.match(projectionBody, /String\(options\.componentKey \|\| ""\)/);
  assert.match(projectionBody, /screenArray\[offset \+ 2\] = record\.componentAttribute/);
  assert.match(meshBody, /ensureSurfaceProjectionAttributes\(entry, cache\.editor \|\| null, \{/);
  assert.match(originalMeshOnlyBranch, /paintView\.assign\(attribute\("paintView", "vec3"\)\)/);
  assert.match(originalMeshOnlyBranch, /paintScreen\.assign\(attribute\("paintScreen", "vec3"\)\)/);
  assert.match(originalMeshOnlyBranch, /paintNormal\.assign\(attribute\("paintNormal", "vec3"\)\)/);
  assert.match(originalMeshOnlyBranch, /paintComponent\.assign\(paintScreen\.z\)/);
  assert.doesNotMatch(originalMeshOnlyBranch, /paintComponent\.assign\(attribute\("paintComponent", "float"\)\)/);
  assert.doesNotMatch(originalMeshOnlyBranch, /paintComponent\.assign\(float\(0\)\)/);
  assert.doesNotMatch(originalMeshOnlyBranch, /modelWorldMatrix\.mul\(vec4\(positionLocal, 1\)\)/);
  assert.doesNotMatch(originalMeshOnlyBranch, /paintNormal\.assign\(normalViewGeometry\)/);
});

test("TSL surface airbrush exposes the source raster mode in debug summaries", () => {
  const runDebugBody = functionSource("exposeSurfaceRunDebug");
  const prewarmDebugBody = functionSource("exposeSurfacePrewarmDebug");
  const prewarmBody = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  assert.match(runDebugBody, /originalMeshUvRaster: stats\.tslSurfaceOriginalMeshUvRaster === true/);
  assert.match(prewarmDebugBody, /originalMeshUvRaster: detail\.originalMeshUvRaster \?\? null/);
  assert.match(prewarmBody, /originalMeshUvRaster: prewarmOriginalMeshUvRaster/);
});

test("TSL surface airbrush parked render targets are reaped after handoff", () => {
  assert.match(source, /function scheduleSurfaceAirbrushParkedResourceReap/);
  assert.match(source, /reapSurfaceAirbrushParkedResources/);
  assert.match(source, /function scheduleAfterSurfaceAirbrushGpuIdle/);
  assert.match(source, /const SURFACE_AIRBRUSH_RETIRE_MIN_AGE_MS = 5000/);
  assert.match(source, /texturePaintTslSurfaceAirbrushRetiredAtMs = surfaceAirbrushNowMs\(\)/);
  assert.match(source, /surfaceAirbrushResourceRetireAgeMs\(resource\) < SURFACE_AIRBRUSH_RETIRE_MIN_AGE_MS/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{/);
  assert.match(source, /host\.requestAnimationFrame\(runAfterQueue\)/);
  assert.match(source, /function markSurfaceAirbrushResourceRetired/);
  assert.match(source, /texturePaintTslSurfaceAirbrushRetiredResource/);
  assert.match(source, /if \(surfaceAirbrushTextureIsLiveTarget\(texture\)\) \{/);
  assert.match(source, /scheduleSurfaceAirbrushParkedResourceReap\(editor\);/);
});

test("TSL surface airbrush does not immediately destroy retired overflow textures", () => {
  const body = functionSource("retireSurfaceAirbrushResource");
  assert.match(body, /retired\.size > SURFACE_AIRBRUSH_RETIRED_RESOURCE_LIMIT/);
  assert.match(body, /parkSurfaceAirbrushResource\(holder, oldest\.resource\)/);
  assert.doesNotMatch(body, /disposeSurfaceAirbrushResourceNow\(oldest\.resource\)/);
});

test("TSL surface airbrush recomputes a live stroke from its stroke-start base texture", () => {
  assert.match(source, /function surfaceStrokeStartsNewStroke/);
  const newStrokeBody = functionSource("surfaceStrokeStartsNewStroke");
  const appendBody = functionSource("appendSurfaceStrokeSegments");
  const strokeBaseBody = functionSource("ensureSurfaceStrokeBaseTexture");
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(source, /function surfaceStrokeStyleKey/);
  assert.match(source, /function surfaceStrokeStyleChanged/);
  assert.match(newStrokeBody, /if \(surfaceStrokeStyleChanged\(cache, styleKey\)\) \{\s*return true;\s*\}/);
  assert.ok(
    newStrokeBody.indexOf("if (surfaceStrokeStyleChanged(cache, styleKey))")
      < newStrokeBody.indexOf("if (surfaceStrokeResetRequested(candidate, options))"),
    "brush or Neighbor style changes must clear the accumulated stroke mask before duplicate checks"
  );
  assert.ok(
    newStrokeBody.indexOf("if (surfaceStrokeResetRequested(candidate, options))")
      < newStrokeBody.indexOf("if (surfaceStrokeSegmentsAlreadyCovered(cache, segments))"),
    "explicit stroke resets must win before duplicate same-stroke continuation"
  );
  assert.match(newStrokeBody, /return cache\.strokeResetOwner !== \(owner \|\| null\)/);
  assert.match(
    newStrokeBody,
    /if \(\s*owner\s*&& Array\.isArray\(cache\?\.surfaceStrokeSegments\)\s*&& cache\.surfaceStrokeSegments\.length\s*\) \{\s*return false;\s*\}/
  );
  assert.ok(
    newStrokeBody.indexOf("if (surfaceStrokeSegmentsAlreadyCovered(cache, segments))")
      < newStrokeBody.indexOf("owner\n    && Array.isArray(cache?.surfaceStrokeSegments)"),
    "same-owner continuation must keep the duplicate segment skip ahead of discontinuous appends"
  );
  assert.match(
    newStrokeBody,
    /return Array\.isArray\(cache\?\.surfaceStrokeSegments\) && cache\.surfaceStrokeSegments\.length > 0;/
  );
  assert.doesNotMatch(newStrokeBody, /return false;\s*$/);
  assert.match(appendBody, /const startsNewStroke = surfaceStrokeStartsNewStroke\(cache, owner, candidate, options, segments, styleKey\)/);
  assert.match(appendBody, /const appendableSegments = startsNewStroke[\s\S]*?segments\.filter\(\(segment\) => !surfaceStrokeSegmentIsPoint\(segment\)\)/);
  assert.match(appendBody, /if \(!startsNewStroke && surfaceStrokeSegmentsAlreadyCovered\(cache, appendableSegments\)\) \{/);
  assert.ok(
    appendBody.indexOf("const startsNewStroke = surfaceStrokeStartsNewStroke(cache, owner, candidate, options, segments, styleKey)")
      < appendBody.indexOf("if (!startsNewStroke && surfaceStrokeSegmentsAlreadyCovered(cache, appendableSegments))"),
    "append path must honor stroke reset before duplicate skipping"
  );
  assert.match(appendBody, /cache\.strokeStyleKey = styleKey/);
  assert.match(body, /const strokeStyleKey = surfaceStrokeStyleKey\(candidate, options\)/);
  assert.match(body, /const strokeStyleChangedAtRunStart = surfaceStrokeStyleChanged\(cache, strokeStyleKey\)/);
  assert.match(body, /const duplicateCoveredSegmentsBeforeReset = !surfaceStrokeOwnerChanged\(cache, strokeSourceOwner\)\s*\n\s*&& !startsNewSurfaceStroke\s*\n\s*&& surfaceStrokeSegmentsAlreadyCovered\(cache, segments\)/);
  assert.match(body, /const pointOnlyContinuation = !startsNewSurfaceStroke[\s\S]*?segments\.every\(\(segment\) => surfaceStrokeSegmentIsPoint\(segment\)\)/);
  assert.match(body, /const duplicateCoveredSegments = pointOnlyContinuation[\s\S]*?\|\| duplicateCoveredSegmentsBeforeReset/);
  assert.match(body, /const strokeOwnerChangedAtRunStart = surfaceStrokeOwnerChanged\(cache, strokeSourceOwner\)/);
  assert.match(body, /const strokeResetRequestedAtRunStart = surfaceStrokeResetRequested\(candidate, options\)/);
  assert.match(body, /let strokeMaskCleared = false/);
  assert.match(body, /clearSurfaceStrokeMaskTarget\(renderer, cache\);\s*\n\s*strokeMaskCleared = true;/);
  assert.match(body, /tslSurfaceStartsNewStroke: startsNewSurfaceStroke/);
  assert.match(body, /tslSurfaceStrokeResetRequested: strokeResetRequestedAtRunStart/);
  assert.match(body, /tslSurfaceStrokeSourceOwner: Boolean\(strokeSourceOwner\)/);
  assert.match(body, /tslSurfaceStrokeOwnerChanged: strokeOwnerChangedAtRunStart/);
  assert.match(body, /tslSurfaceStrokeStyleChanged: strokeStyleChangedAtRunStart/);
  assert.match(body, /tslSurfaceStrokeStyleKey: strokeStyleKey/);
  assert.match(body, /tslSurfaceDuplicateCoveredSegments: duplicateCoveredSegments/);
  assert.match(body, /tslSurfaceStrokeMaskCleared: strokeMaskCleared/);
  assert.match(body, /tslSurfaceStartsNewStroke: startsNewSurfaceStroke,[\s\S]*?tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(body, /tslSurfaceStrokeSourceOwner: Boolean\(strokeSourceOwner\),[\s\S]*?tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(body, /tslSurfaceStrokeMaskCleared: false,[\s\S]*?tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(body, /cache\.strokeBaseTexture = null/);
  assert.match(body, /cache\.strokeBaseTexture = freezeLiveStrokeBase[\s\S]*?\? ensureSurfaceStrokeBaseTexture\([\s\S]*?renderer,[\s\S]*?cache,[\s\S]*?sourceTexture[\s\S]*?: surfaceStrokeStartBaseTexture\(cache, sourceTexture\)/);
  assert.match(body, /const continuingEmptyLayerStroke = Boolean\(\s*layerMode\s*&& !startsNewSurfaceStroke\s*&& cache\.strokeBaseWasEmptyLayer === true/);
  assert.match(body, /const baseTexture = cache\.strokeBaseTexture \|\| sourceTexture/);
  assert.match(strokeBaseBody, /surfaceAirbrushCacheOwnsTexture\(cache, sourceTexture\)/);
  assert.doesNotMatch(body, /direct-paint-target/);
});

test("TSL surface airbrush stroke style keeps pressure channels inside one pointer-down stroke", () => {
  const body = functionSource("surfaceStrokeStyleKey");
  assert.match(body, /const neighborSeed = options\.neighborPaintSeed \|\| candidate\?\.options\?\.neighborPaintSeed \|\| null/);
  assert.match(body, /const neighborKey = String\(/);
  assert.match(body, /options\.neighborPaintKey/);
  assert.match(body, /candidate\?\.options\?\.neighborPaintKey/);
  assert.match(body, /neighborSeed\?\.key/);
  assert.match(body, /const neighborEnabled = Boolean\(/);
  assert.match(body, /neighborSeed\?\.enabled === true/);
  assert.match(body, /options\.largeLiveNeighborPaint === true/);
  assert.match(body, /candidate\?\.options\?\.largeLiveNeighborPaint === true/);
  assert.match(body, /neighborEnabled \? "neighbor" : "no-neighbor"/);
  assert.match(body, /neighborKey/);
  assert.match(body, /"large-neighbor"/);
  assert.match(body, /"component-gate"/);
  assert.match(body, /const pressureOpacity = options\.pressureOpacity === true/);
  assert.match(body, /const pressureHardness = options\.pressureHardness === true/);
  assert.match(body, /const pressureScatter = options\.pressureScatter === true/);
  assert.match(body, /pressureOpacity[\s\S]*?\? "pressure-opacity"[\s\S]*?: Math\.round\(finiteNumber\(options\.opacity/);
  assert.match(body, /pressureHardness[\s\S]*?\? "pressure-hardness"[\s\S]*?: Math\.round\(finiteNumber\(options\.hardness/);
  assert.match(body, /pressureScatter[\s\S]*?\? "pressure-scatter"[\s\S]*?: Math\.round\(finiteNumber\(options\.scatter/);
  assert.doesNotMatch(body, /screenRadiusPixels/);
  assert.doesNotMatch(body, /radiusPixels/);
});

test("TSL surface airbrush renders live segments instead of retaining a stale target", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.doesNotMatch(body, /skipStaleFullSurfaceRender = Boolean/);
  assert.doesNotMatch(body, /retainedTarget/);
  assert.doesNotMatch(body, /"retained"/);
  assert.match(body, /renderer\.render\(cache\.scene, cache\.camera\)/);
  assert.match(body, /tslSurfaceSkippedStaleFullSurfaceRender: false/);
});

test("TSL projected primary expands UV gutters instead of leaving seam gutters unpainted", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.doesNotMatch(body, /useProjectedPrimary \? 0 : UV_GUTTER_PIXELS/);
  assert.match(body, /ensureProjectedSurfaceMesh\([\s\S]*?baseTexture,\s*\n\s*UV_SEAM_BLEED_PIXELS/);
  assert.doesNotMatch(body, /ensureProjectedSurfaceMesh\([\s\S]*?referenceTexture,\s*\n\s*UV_SEAM_BLEED_PIXELS/);
});

test("TSL surface airbrush does not seed a new stroke from a stale live target", () => {
  assert.match(source, /function surfaceAirbrushCacheOwnsTexture/);
  assert.match(source, /function surfaceAirbrushStableTextureFromLiveTarget/);
  assert.match(source, /function surfaceAirbrushDisplayedPaintSourceTexture/);
  assert.match(source, /function surfaceAirbrushReferenceTexture/);
  const ownsBody = functionSource("surfaceAirbrushCacheOwnsTexture");
  const displayedSourceBody = functionSource("surfaceAirbrushDisplayedPaintSourceTexture");
  const originalMapBody = functionSource("surfaceEditableOriginalMap");
  const referenceBody = functionSource("surfaceAirbrushReferenceTexture");
  const boundBody = functionSource("surfaceAirbrushCachedTextureStillBound");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(ownsBody, /cache\.dilationTargets/);
  assert.match(ownsBody, /cache\.strokeBaseTarget\?\.texture === texture/);
  assert.match(originalMapBody, /textureAirbrushWebGpuCanvasMap/);
  assert.match(displayedSourceBody, /texturePaintTslSurfaceDisplaySourceTexture/);
  assert.match(displayedSourceBody, /materialUserData\.clonePaintTexture/);
  assert.match(displayedSourceBody, /editable\?\.texture/);
  assert.match(displayedSourceBody, /surfaceAirbrushTextureIsLiveTarget\(texture\)/);
  assert.match(displayedSourceBody, /surfaceAirbrushCacheOwnsTexture\(cache, texture\)/);
  assert.doesNotMatch(originalMapBody, /hasOwnProperty\.call\(userData, "clonePaintOriginalMap"\)\) \{\s*return userData\.clonePaintOriginalMap \|\| null;/);
  assert.doesNotMatch(referenceBody, /displayIsCurrentCacheTarget/);
  assert.match(referenceBody, /const displayedPaintSource = surfaceAirbrushDisplayedPaintSourceTexture\(material, editable, cache\)/);
  assert.match(referenceBody, /for \(const texture of \[\s*displayedPaintSource,\s*originalMap,/);
  assert.match(referenceBody, /!surfaceAirbrushCacheOwnsTexture\(cache, displayTexture\)/);
  assert.match(referenceBody, /!surfaceAirbrushTextureIsLiveTarget\(displayTexture\)[\s\S]*?\? displayTexture[\s\S]*?: null/);
  assert.match(boundBody, /surfaceAirbrushCacheOwnsTexture\(cache, currentTexture\)/);
  assert.match(boundBody, /editable\?\.layer\?\.gpuTarget\?\.target\?\.texture === currentTexture/);
  assert.match(runBody, /surfaceAirbrushReferenceTexture\(material, editable, materialOriginalMap, cache\)/);
  assert.match(runBody, /surfaceAirbrushCachedTextureStillBound\(\s*cache,\s*material,\s*editable\s*\)/);
});

test("TSL surface airbrush keeps live drag segments until the next stroke reset", () => {
  const body = functionSource("appendSurfaceStrokeSegments");
  const tailBody = functionSource("surfaceStrokeUncoveredSegments");
  assert.match(tailBody, /surfaceStrokeSegmentAlreadyCovered\(existing, segments\[firstUncoveredIndex\]\)/);
  assert.match(tailBody, /segments\.slice\(firstUncoveredIndex\)/);
  assert.match(body, /Array\.isArray\(cache\.surfaceStrokeSegments\)/);
  assert.match(body, /\[\.\.\.cache\.surfaceStrokeSegments\]/);
  assert.match(body, /startsNewStroke \|\| ownerChanged\s*\?\s*\[\]/);
  assert.match(body, /const segmentsToAppend = startsNewStroke \|\| ownerChanged/);
  assert.match(body, /surfaceStrokeUncoveredSegments\(outputSegments, appendableSegments\)/);
  assert.match(body, /const firstSegment = segmentsToAppend\[0\] \|\| null/);
  assert.match(body, /outputSegments\.push\(\.\.\.segmentsToAppend\)/);
  assert.doesNotMatch(body, /outputSegments\.push\(\.\.\.segments\)/);
});

test("TSL surface reset is consumed once when one live stroke crosses paint surfaces", () => {
  const strokeOwner = {};
  const styleKey = "paint|layer";
  const chestSegment = {
    start: { x: 120, y: 90 },
    end: { x: 150, y: 120 },
    radius: 24
  };
  const apronSegment = {
    start: { x: 150, y: 120 },
    end: { x: 165, y: 180 },
    radius: 24
  };
  const cache = {
    strokeSourceOwner: strokeOwner,
    strokeResetOwner: strokeOwner,
    strokeStyleKey: styleKey,
    surfaceStrokeSegments: [chestSegment],
    previousSurfaceStrokeSegment: chestSegment
  };

  assert.equal(
    surfaceStrokeStartsNewStroke(
      cache,
      strokeOwner,
      { strokeReset: true },
      { strokeReset: true },
      [apronSegment],
      styleKey
    ),
    false,
    "the apron candidate must continue the chest candidate owned by the same pen stroke"
  );
  assert.equal(
    surfaceStrokeStartsNewStroke(
      cache,
      {},
      { strokeReset: true },
      { strokeReset: true },
      [apronSegment],
      styleKey
    ),
    true,
    "a later pen-down owner must still start a new opacity stroke"
  );
});

test("TSL layer starts an apron stroke from the chest stroke GPU result", () => {
  const paintedLayerTexture = {};
  const cache = {
    currentTexture: paintedLayerTexture,
    hasPaintedSurfaceStroke: true,
    targets: [{ texture: paintedLayerTexture }]
  };
  const material = {
    map: { name: "layer display composite" }
  };
  const editable = {
    layerMode: true,
    texture: { name: "editable canvas texture" },
    layer: {
      gpuTarget: {
        target: {
          texture: paintedLayerTexture
        }
      }
    }
  };

  assert.equal(
    surfaceAirbrushCachedTextureStillBound(cache, material, editable),
    true,
    "the raw active-layer target remains authoritative while the material displays its composite"
  );
  editable.layer.gpuTarget.target.texture = {};
  assert.equal(
    surfaceAirbrushCachedTextureStillBound(cache, material, editable),
    false,
    "an unrelated layer target must not inherit the previous stroke"
  );
});

test("TSL surface airbrush breaks a Neighbor path without clearing stroke opacity", () => {
  const resetBody = functionSource("surfaceStrokeResetRequested");
  const pathResetBody = functionSource("surfaceStrokePathResetRequested");
  const appendBody = functionSource("appendSurfaceStrokeSegments");
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(pathResetBody, /candidate\?\.strokePathReset === true/);
  assert.match(pathResetBody, /candidate\?\.options\?\.strokePathReset === true/);
  assert.match(pathResetBody, /options\.strokePathReset === true/);
  assert.doesNotMatch(resetBody, /strokePathReset/);
  assert.match(appendBody, /const resetsStrokePath = !startsNewStroke && surfaceStrokePathResetRequested\(candidate, options\)/);
  assert.match(appendBody, /if \(resetsStrokePath\) \{\s*cache\.previousSurfaceStrokeSegment = null;\s*\}/);
  assert.match(runBody, /if \(!startsNewSurfaceStroke && strokePathResetRequestedAtRunStart\) \{\s*cache\.previousSurfaceStrokeSegment = null;\s*\}/);
  assert.doesNotMatch(pathResetBody, /strokeMaskInitialized/);
});

test("TSL surface airbrush Hermite-bridges short screen-only batch gaps", () => {
  const continuityBody = functionSource("surfaceStrokeSegmentsAreContinuous");
  const bridgeBody = functionSource("surfaceStrokeHermiteBridgeSegments");
  const appendBody = functionSource("appendSurfaceStrokeSegments");
  assert.match(continuityBody, /screenGap > radius \* 2\.25/);
  assert.match(continuityBody, /previousComponentEnd !== firstComponentStart/);
  assert.match(continuityBody, /if \(!previousViewEnd \|\| !firstViewStart\) \{\s*return true;/);
  assert.match(bridgeBody, /surfaceStrokeForwardTangent\(previousSegment\?\.start, previousSegment\?\.end, chord, tangentLimit\)/);
  assert.match(bridgeBody, /surfaceStrokeForwardTangent\(firstSegment\?\.start, firstSegment\?\.end, chord, tangentLimit\)/);
  assert.match(bridgeBody, /surfaceStrokeHermitePoint\(start, end, startTangent, endTangent, t\)/);
  assert.match(bridgeBody, /Math\.min\(8, Math\.ceil\(gap \/ pieceLength\)\)/);
  assert.match(appendBody, /surfaceStrokeHermiteBridgeSegments\(previousSegment, firstSegment\)/);
});

test("TSL surface airbrush does not render detached point stamps during a live continuation", () => {
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  const appendBody = functionSource("appendSurfaceStrokeSegments");
  assert.match(source, /function surfaceStrokeSegmentIsPoint\(segment = null\)/);
  assert.match(source, /surfaceStrokePointDistance\(segment\?\.start, segment\?\.end\) <= 0\.001/);
  assert.match(appendBody, /const appendableSegments = startsNewStroke\s*\? segments\s*:\s*segments\.filter\(\(segment\) => !surfaceStrokeSegmentIsPoint\(segment\)\)/);
  assert.match(appendBody, /if \(!appendableSegments\.length\) \{[\s\S]*?cache\.lastSurfaceStrokeAppendSegments = \[\]/);
  assert.match(runBody, /const pointOnlyContinuation = !startsNewSurfaceStroke/);
  assert.ok(
    runBody.indexOf("const pointOnlyContinuation = !startsNewSurfaceStroke")
      < runBody.indexOf("if (duplicateCoveredSegments && cache.currentTexture"),
    "point-only continuations must enter the no-composite skip path"
  );
  assert.match(runBody, /const newlyAppendedPaintSegments = Array\.isArray\(cache\.lastSurfaceStrokeAppendSegments\)\s*\? cache\.lastSurfaceStrokeAppendSegments/);
});
