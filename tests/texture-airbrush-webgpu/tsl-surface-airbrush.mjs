import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

const source = readFileSync(new URL("../../src/texture-paint/surface-airbrush-tsl.js", import.meta.url), "utf8");
const strokeSource = readFileSync(new URL("../../src/weight-editor/airbrush/webgpu-stroke.js", import.meta.url), "utf8");
const liveSource = readFileSync(new URL("../../src/weight-editor/airbrush/webgpu-live.js", import.meta.url), "utf8");
const projectionSource = readFileSync(new URL("../../src/weight-editor/airbrush/webgpu-projection.js", import.meta.url), "utf8");
const clonePaintSource = readFileSync(new URL("../../src/weight-editor/clone-paint.js", import.meta.url), "utf8");
const paintToolsSource = readFileSync(new URL("../../src/weight-editor/paint-tools.js", import.meta.url), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
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

test("TSL surface airbrush keeps the final brush field surface-continuous", () => {
  const body = functionSource("createSurfaceMaterial");
  const sampleIndex = body.indexOf("const surfaceFieldCoverage");
  assert.ok(sampleIndex > -1, "createSurfaceMaterial should derive surface coverage");
  assert.doesNotMatch(body, /const viewDistancePermission/);
  assert.doesNotMatch(body, /const viewDistanceSoftPermission/);
  assert.doesNotMatch(body, /const depthPermission/);
  assert.doesNotMatch(body, /const depthSoftPermission/);
  assert.doesNotMatch(body, /const visibleHardPermission/);
  assert.doesNotMatch(source, /VISIBLE_SURFACE_DEPTH_GATE_/);
  assert.doesNotMatch(body, /visibleBehindDepth|visibleDepthGate|visibleDepthCoverage|visibleGateCoverage/);
  assert.doesNotMatch(body, /visiblePermission|visibleSoftPermission/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.85\)/);
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(0\.9\)/);
  assert.doesNotMatch(body, /mix\(visibleSoftPermission, visibleHardPermission, hardVisibleEdge\)/);
  assert.doesNotMatch(body, /visibleOccluded/);
  assert.doesNotMatch(body, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.doesNotMatch(body, /segmentViewStarts\.element\(i\)/);
  assert.doesNotMatch(body, /segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(body, /const hasViewField =/);
  assert.doesNotMatch(body, /const viewDistance = length\(editorView\.sub\(viewClosest\)\)/);
  assert.doesNotMatch(body, /const viewDistanceCoverage = viewEdgeCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const viewDepthDelta = abs\(editorView\.z\.sub\(viewClosest\.z\)\)\.toVar\(\)/);
  assert.doesNotMatch(source, /SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_SCALE/);
  assert.doesNotMatch(source, /SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_SCALE/);
  assert.doesNotMatch(body, /const visibleDepthFade =/);
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
  assert.match(body, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.match(body, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.match(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
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
  const normalBody = functionSource("viewNormalForVertex");
  const skinBody = functionSource("skinLocalNormalForVertex");
  assert.match(normalBody, /skinLocalNormalForVertex\(object, geometry, vertexIndex, _scratchNormal\)/);
  assert.match(skinBody, /geometry\?\.attributes\?\.skinIndex/);
  assert.match(skinBody, /geometry\?\.attributes\?\.skinWeight/);
  assert.match(skinBody, /skeleton\.getBoneMatrix\(boneIndex, _scratchBoneMatrix\)/);
  assert.match(skinBody, /_scratchSkinMatrix\.multiplyMatrices\(object\.bindMatrixInverse, _scratchSkinMatrix\)\.multiply\(object\.bindMatrix\)/);
  assert.match(skinBody, /_scratchNormal4\.set\(normal\.x, normal\.y, normal\.z, 0\)\.applyMatrix4\(_scratchSkinMatrix\)/);
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
  assert.match(strokeSource, /const sameSurfaceComponent = \(leftComponent = -1, rightComponent = -1\) =>/);
  assert.match(strokeSource, /const bridgeOnSameSurface = \(previous = null, segment = null\) =>/);
  assert.match(strokeSource, /!sameSurfaceComponent\([\s\S]*?previous\.componentEnd \?\? previous\.componentStart[\s\S]*?segment\.componentStart \?\? segment\.componentEnd[\s\S]*?\)/);
  assert.match(strokeSource, /const segmentCrossesComponents = Number\.isFinite\(segmentComponentStart\)[\s\S]*?segmentComponentStart !== segmentComponentEnd/);
  assert.match(strokeSource, /const surfaceSegment = segmentCrossesComponents[\s\S]*?componentEnd: segmentComponentStart/);
  assert.match(strokeSource, /&& bridgeOnSameSurface\(previous, surfaceSegment\)/);
  assert.match(strokeSource, /const crossesComponents = !sameSurfaceComponent\(startAnchor\.component, endAnchor\.component\)/);
  assert.match(strokeSource, /const remoteViewEnd = crossesComponents \|\| !sameSurfaceEndpoint/);
  assert.match(strokeSource, /const safeEndNormal = remoteViewEnd[\s\S]*?\? startAnchor\.normal[\s\S]*?: endAnchor\.normal/);
  assert.match(strokeSource, /viewNormalEnd: safeEndNormal/);
  assert.match(strokeSource, /const maxScreenDistance = Math\.max\(10, \(Number\(radiusPixelsForSegment\) \|\| screenRadiusPixels\) \* 1\.6\)/);
  assert.match(strokeSource, /return bestDistance <= maxScreenDistance \? best : null/);
  assert.doesNotMatch(strokeSource, /reusedAnchor[\s\S]*?return null/);
  assert.match(strokeSource, /\}\)\.filter\(Boolean\);[\s\S]*?const projectedFieldStrokeSegments = surfaceEnrichedScreenPaintStrokeSegments\.length[\s\S]*?: projectedSurfaceBrushSegments\.length[\s\S]*?: screenPaintStrokeSegments/);
  assert.match(strokeSource, /viewNormalStart: previous\.viewNormalEnd \|\| previous\.viewNormalStart/);
  assert.match(strokeSource, /viewNormalEnd: surfaceSegment\.viewNormalStart \|\| surfaceSegment\.viewNormalEnd/);
  assert.match(strokeSource, /const needsIndexedNormalAnchors = !anchors\.length \|\| !anchors\.some\(\(anchor\) => anchor\?\.normal\)/);
  assert.match(strokeSource, /const indexedAnchorSegments = screenPaintStrokeSegments\.slice\(0, Math\.min\(screenPaintStrokeSegments\.length, 24\)\)/);
  assert.match(strokeSource, /if \(needsIndexedNormalAnchors && typeof editor\?\.textureAirbrushScreenHitsForEvent === "function"\)/);
  assert.match(strokeSource, /const sameDistance = Math\.abs\(distance - bestDistance\) <= 0\.001/);
  assert.match(strokeSource, /distance < bestDistance \|\| \(sameDistance && !best\?\.normal && anchor\?\.normal\)/);
  assert.match(strokeSource, /const useTslSourceMeshVisibilitySeed = skipProjectedSeamStrokeSegmentsForTslSurface/);
  assert.match(strokeSource, /const visibilityTriangleLimitForSurfaceSeed = useTslSourceMeshVisibilitySeed[\s\S]*?Math\.max\(32,[\s\S]*?Math\.min\([\s\S]*?512/);
  assert.match(strokeSource, /const screenBrushVisibilityTrianglesForSurfaceSeed = options\.screenBrushVisibilityTriangles/);
  assert.match(strokeSource, /screenBrushVisibilityTriangles: screenBrushVisibilityTrianglesForSurfaceSeed/);
  assert.match(strokeSource, /fullBrushVisibilityProbes: useTslSourceMeshVisibilitySeed \? false : options\.fullBrushVisibilityProbes/);
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

test("TSL surface airbrush keeps screen coverage independent of visible-depth masks", () => {
  const surfaceBody = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  assert.doesNotMatch(surfaceBody, /viewDistancePermission/);
  assert.doesNotMatch(surfaceBody, /depthSoftPermission/);
  assert.doesNotMatch(surfaceBody, /depthPermission/);
  assert.doesNotMatch(surfaceBody, /depthHardPermission/);
  assert.doesNotMatch(surfaceBody, /const screenOnlyCoverage = visibleActive\.greaterThan\(0\.5\)/);
  assert.doesNotMatch(surfaceBody, /segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(surfaceBody, /const viewDistance = length\(editorView\.sub\(viewClosest\)\)/);
  assert.doesNotMatch(surfaceBody, /visibleGateCoverage|visibleDepthCoverage/);
  assert.doesNotMatch(surfaceBody, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(surfaceBody, /normalCompatibility|surfacePlanePermission/);
  assert.match(surfaceBody, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.match(surfaceBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.match(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(surfaceBody, /visibleCoverage|visiblePermission|visibleSoftPermission/);
  assert.doesNotMatch(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentPermission\)/);
  assert.doesNotMatch(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(surfaceBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(bridgePermission\)/);
  assert.doesNotMatch(surfaceBody, /\.mul\(viewDistancePermission\)[\s\S]*?\.mul\(depthPermission\)[\s\S]*?\.mul\(visibleCoverage\)/);
  assert.doesNotMatch(surfaceBody, /mix\(viewCoverage, float\(1\)/);
  assert.match(projectedBody, /gatedCoverage/);
  assert.match(projectedBody, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(componentPermission\)/);
  assert.doesNotMatch(projectedBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(bridgePermission\)/);
  assert.match(projectedBody, /const sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(normalGate\)/);
  assert.doesNotMatch(projectedBody, /sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(visibleCoverage\)/);
  assert.doesNotMatch(projectedBody, /const sampleCoverage = baseSampleCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(projectedBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?viewDistancePermission/);
  assert.match(projectedBody, /coverage\.assign\(max\(coverage, sampleCoverage\)\)/);
  assert.match(projectedBody, /const noCoverage = alpha\.lessThanEqual\(TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD\)\.toVar\(\)/);
  assert.match(projectedBody, /gutterOnly[\s\S]*?\.select\(insideOriginalTriangle\.or\(noCoverage\), noCoverage\)/);
  assert.match(projectedBody, /discardFragment\.discard\(\)/);
  assert.doesNotMatch(projectedBody, /const screenOnlyCoverage = visibleActive\.greaterThan\(0\.5\)/);
  assert.doesNotMatch(projectedBody, /segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(projectedBody, /const viewDistance = length\(editorView\.sub\(viewClosest\)\)/);
  assert.doesNotMatch(projectedBody, /visibleGateCoverage|visibleDepthCoverage/);
  assert.doesNotMatch(projectedBody, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(projectedBody, /normalCompatibility|surfacePlanePermission/);
  assert.match(projectedBody, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /viewRadiusRaw\.greaterThan\(0\.0001\)[\s\S]*?\.select\(mix\(viewCoverage/);
  assert.doesNotMatch(projectedBody, /screenCoverage\.mul\(surfaceGate\)/);
});

test("TSL surface airbrush evaluates coverage in captured hit-screen space", () => {
  const body = functionSource("createSurfaceMaterial");
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  const sourceVertexBody = functionSource("addSourceRasterVertex");
  assert.match(body, /paintView\.assign\(attribute\("paintView", "vec3"\)\)/);
  assert.match(body, /paintScreen\.assign\(attribute\("paintScreen", "vec3"\)\)/);
  assert.match(body, /const surfaceScreen = paintScreen\.toVar\(\)/);
  assert.match(projectedBody, /const surfaceScreen = paintScreen\.toVar\(\)/);
  assert.doesNotMatch(body, /const projectedClip = editorProjectionMatrix\.mul\(vec4\(editorView, 1\)\)\.toVar\(\)/);
  assert.doesNotMatch(projectedBody, /const projectedClip = editorProjectionMatrix\.mul\(vec4\(editorView, 1\)\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const projectedSurfaceScreen = vec3/);
  assert.doesNotMatch(projectedBody, /const projectedSurfaceScreen = vec3/);
  assert.match(source, /function ensureSurfaceProjectionAttributes/);
  assert.match(source, /screenPointForWorld\(editor, world\)/);
  assert.match(source, /function textureNodeAppliesFlipY/);
  assert.match(sourceVertexBody, /textureNodeAppliesFlipY\(referenceTexture\) \? 1 - sampleV : sampleV/);
  assert.ok(
    body.indexOf('paintScreen.assign(attribute("paintScreen", "vec3"))') <
      body.indexOf("return vec4(positionLocal.x"),
    "surface screen position must be captured before the vertex is moved into UV space"
  );
});

test("TSL surface airbrush keeps a direct stroke-start base for mask composites", () => {
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
  assert.match(runBody, /cache\.strokeBaseTexture = surfaceStrokeStartBaseTexture\(cache, sourceTexture\)/);
  assert.match(runBody, /texturePaintTslSurfaceLastStrokeBaseCopy = cache\.strokeBaseTexture === sourceTexture[\s\S]*?\? "direct-source"[\s\S]*?: "stable-source"/);
  assert.doesNotMatch(runBody, /cache\.strokeBaseTexture = ensureSurfaceStrokeBaseTexture/);
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
  assert.match(source, /const SOFT_FACING_NORMAL_BACK_FEATHER = 0\.0/);
  assert.match(source, /const SOFT_FACING_NORMAL_FRONT_FEATHER = 0\.12/);
  assert.doesNotMatch(source, /SURFACE_NORMAL_COMPATIBILITY_MIN/);
  assert.doesNotMatch(source, /SURFACE_NORMAL_COMPATIBILITY_FULL/);
  assert.match(source, /const VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS = 0\.18/);
  assert.doesNotMatch(source, /VISIBLE_SURFACE_DEPTH_RADIUS|VISIBLE_SURFACE_DEPTH_FEATHER_RADIUS/);
  assert.doesNotMatch(source, /SURFACE_AIRBRUSH_VIEW_DEPTH_RADIUS_SCALE/);
  assert.doesNotMatch(source, /SURFACE_AIRBRUSH_VIEW_DEPTH_FEATHER_SCALE/);
  assert.doesNotMatch(body, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.doesNotMatch(body, /strokeFacingSign/);
  assert.doesNotMatch(body, /mix\(float\(1\), strokeFacingSign, normalPresence\)/);
  assert.match(body, /const currentFacingNormalZ = editorNormalLength\.greaterThan\(0\.0002\)/);
  assert.doesNotMatch(source, /VISIBLE_NORMAL_RESCUE_DEPTH_TOLERANCE/);
  assert.match(body, /const visibleFacingSampleZ = visibleSample\.g\.mul\(2\.0\)\.sub\(1\.0\)\.toVar\(\)/);
  assert.match(body, /const visibleNormalRescue = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?visibleDelta\.lessThanEqual\(VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS\)/);
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
  assert.match(projectedBody, /const visibleNormalRescue = visibleActive[\s\S]*?\.mul\(visibleSampleValid\)[\s\S]*?visibleDelta\.lessThanEqual\(VISIBLE_SURFACE_NORMAL_SAMPLE_RADIUS\)/);
  assert.doesNotMatch(source, /VISIBLE_SURFACE_DEPTH_GATE_/);
  assert.doesNotMatch(body, /visibleBehindDepth|visibleDepthGate|visibleDepthCoverage|visibleGateCoverage/);
  assert.doesNotMatch(projectedBody, /visibleBehindDepth|visibleDepthGate|visibleDepthCoverage|visibleGateCoverage/);
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

test("TSL visible-surface depth and normal buffer uses linear filtering", () => {
  const body = functionSource("createVisibleSurfaceTarget");
  assert.match(body, /target\.texture\.minFilter = THREE\.LinearFilter/);
  assert.match(body, /target\.texture\.magFilter = THREE\.LinearFilter/);
  assert.doesNotMatch(body, /target\.texture\.minFilter = THREE\.NearestFilter/);
  assert.doesNotMatch(body, /target\.texture\.magFilter = THREE\.NearestFilter/);
});

test("TSL surface airbrush uses the shared airbrush falloff constants", () => {
  const body = functionSource("createSurfaceMaterial");
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
  }
  assert.ok(
    [...body.matchAll(/radius\.mul\(float\(1\)\.add\(scatter\.mul\(0\.15\)\)\)\.toVar\(\)/g)].length >= 1,
    "screen brush halo should keep scatter visible without doubling the configured brush radius"
  );
  assert.doesNotMatch(body, /viewRadius\.mul\(float\(1\)\.add\(scatter\.mul\(0\.15\)\)\)\.toVar\(\)/);
  assert.doesNotMatch(body, /softness\.mul\(TEXTURE_AIRBRUSH_SOFT_HALO_SCALE\)/);
  assert.doesNotMatch(body, /scatter\.mul\(TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE\)/);
  assert.doesNotMatch(body, /tailAlpha|tailCoverage|tailSmooth/);
  assert.match(body, /const fadeRadius = max\(haloRadius\.sub\(coreRadius\), 0\.0001\)/);
  assert.match(body, /const edgeCoverage = max\(0\.0, float\(1\)\.sub\(smoothEdge\)\)\.toVar\(\)/);
  assert.match(body, /const screenCoverage = edgeCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /segmentViewEnds\.element\(i\)/);
  assert.doesNotMatch(body, /const viewDistance = length\(editorView\.sub\(viewClosest\)\)/);
  assert.doesNotMatch(body, /const viewDistanceCoverage = viewEdgeCoverage\.toVar\(\)/);
  assert.doesNotMatch(body, /const surfaceProjectedCoverage = min\(screenCoverage, viewCoverage\)\.toVar\(\)/);
  assert.doesNotMatch(body, /const componentPermission = hasComponentGate/);
  assert.doesNotMatch(body, /normalCompatibility|surfacePlanePermission/);
  assert.match(body, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.match(body, /const surfaceFieldCoverage = brushFieldCoverage\.toVar\(\)/);
  assert.match(body, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(body, /visibleCoverage|visiblePermission|visibleSoftPermission/);
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
  assert.equal(TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE, 0);
});

test("TSL surface airbrush can gate ambiguous UV overlap texels", () => {
  assert.match(source, /const UV_OVERLAP_MASK_SIZE = 1024/);
  assert.match(source, /function surfaceAirbrushUvOverlapMaskEnabled/);
  assert.match(source, /debugAirbrushUvOverlapMask/);
  assert.match(source, /function sourceObjectUvOverlapMaskTexture/);
  assert.match(source, /UV_OVERLAP_DISTANCE_THRESHOLD/);
  assert.match(source, /new THREE\.DataTexture/);
  const body = functionSource("createSurfaceMaterial");
  assert.match(body, /const overlapMaskTexture = sourceObjectUvOverlapMaskTexture\(sourceObject\)/);
  assert.match(body, /const overlapMaskTextureNode = texture\(overlapMaskTexture, paintUv\)/);
  assert.match(body, /const overlapSample = overlapMaskTextureNode\.toVar\(\)/);
  assert.match(body, /const overlapCanWrite = overlapSample\.r\.greaterThan\(0\.5\)\.toVar\(\)/);
  assert.match(body, /\.or\(occupancySample\.r\.lessThan\(0\.5\)\)[\s\S]*?\.and\(overlapCanWrite\)/);
  assert.match(source, /tslSurfaceOverlapMaskAmbiguousTexels/);
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
  assert.match(body, /sourceObjectsForEditable\(editor, candidate, editable, sourceTexture, referenceTexture\)/);
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

test("TSL surface airbrush rebinds shared source-image material slots", () => {
  const matcherBody = functionSource("materialUsesEditableTexture");
  const bindBody = functionSource("bindSurfaceTextureToMatchingMaterials");
  assert.match(matcherBody, /const allowImageMatch = options\.allowImageMatch !== false/);
  assert.match(matcherBody, /allowImageMatch && materialImage && editableImages\.has\(materialImage\)/);
  assert.match(matcherBody, /allowImageMatch && materialImage && textureImage && materialImage === textureImage/);
  assert.match(bindBody, /materialUsesEditableTexture\(candidateMaterial, editable, textureSet, \{ allowImageMatch: true \}\)/);
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
  assert.match(source, /const SOURCE_RASTER_GEOMETRY_MIN_TRIANGLES = 4096/);
  assert.match(source, /const UV_GUTTER_PIXELS = 0/);
  assert.match(source, /const UV_SEAM_BLEED_PIXELS = 8/);
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
  assert.doesNotMatch(body, /debugAirbrushNoSourceRasterClip/);
  assert.doesNotMatch(body, /debugAirbrushClipSourceRaster/);
  assert.match(source, /function surfaceAirbrushOriginalMeshUvRasterEnabled/);
  assert.match(source, /debugAirbrushSourceMeshUvRaster/);
  assert.match(source, /return true;/);
  assert.doesNotMatch(source, /debugAirbrushExpandedSourceUvRaster/);
  assert.doesNotMatch(body, /const liveSurfaceStrokeForRasterClip = options\.liveProjectedPaint === true \|\| options\.screenStrokePaint === true/);
  assert.match(body, /const liveProjectedPaint = options\.liveProjectedPaint === true/);
  assert.match(body, /const screenStrokePaint = options\.screenStrokePaint === true/);
  assert.match(body, /const liveStrokeMaskComposite = useStrokeMaskComposite[\s\S]*?&& \(liveProjectedPaint \|\| screenStrokePaint\)/);
  assert.match(body, /const useSourceRasterClip = !layerMode\s+&& useStrokeMaskComposite\s+&& surfaceAirbrushSourceRasterClipEnabled\(\)/);
  assert.match(body, /const sourceRasterClipPath = useSourceRasterClip[\s\S]*?simplifiedSourceRasterClipSegments\(renderPaintSegments, 18\)/);
  assert.match(body, /const useOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled\(\)/);
  assert.doesNotMatch(body, /const useOriginalMeshUvRaster = layerMode[\s\S]*?\? false/);
  assert.match(body, /originalMeshUvRaster: useOriginalMeshUvRaster/);
  assert.match(body, /sourceRasterClipSegments: sourceRasterClipPath/);
  assert.match(body, /tslSurfaceSourceRasterClipActive: sourceRasterOptions\.originalMeshUvRaster !== true[\s\S]*?&& sourceRasterClipSegments\(sourceRasterOptions\)\.length > 0/);
  assert.doesNotMatch(body, /sourceRasterClipSegments: paintSegments/);
  const clipRadiusBody = functionSource("sourceRasterClipDomainRadius");
  assert.match(clipRadiusBody, /scatter \* \(TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE \+ 0\.35\)/);
  assert.match(clipRadiusBody, /const hardness = sourceRasterClipHardness\(options\)/);
  assert.match(clipRadiusBody, /const softness = 1 - hardness/);
  assert.match(clipRadiusBody, /softness \* TEXTURE_AIRBRUSH_SOFT_HALO_SCALE/);
  assert.match(functionSource("sourceRasterClipKey"), /sourceRasterClipHardness\(options\)/);
  assert.match(body, /sourceRasterClipHardness: options\.hardness/);
  assert.match(source, /function simplifiedSourceRasterClipSegments/);
  assert.match(source, /const TSL_SURFACE_DILATION_PASSES = 1/);
});

test("TSL surface airbrush skips duplicate live batches before projected geometry work", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const duplicateIndex = body.indexOf("const duplicateCoveredSegmentsBeforeReset = !surfaceStrokeOwnerChanged(cache, strokeSourceOwner)");
  const projectedIndex = body.indexOf("cachedMeshUvProjectedTriangles(cache, editor, candidate, width, height)");
  const newStrokeIndex = body.indexOf("const startsNewSurfaceStroke = surfaceStrokeStartsNewStroke(cache, strokeSourceOwner, candidate, options, segments)");
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

test("TSL surface airbrush keeps GPU dilation live without CPU fallback", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const dilationBody = functionSource("runSurfaceDilation");
  const dilationSeedBody = functionSource("createDilationSeedMaterial");
  const updateDilationSeedBody = functionSource("updateDilationSeedMaterial");
  const ensureDilationBody = functionSource("ensureDilationResources");
  const dilationMaterialBody = functionSource("createDilationMaterial");
  assert.doesNotMatch(body, /const liveSurfaceStroke = options\.liveProjectedPaint === true \|\| options\.screenStrokePaint === true/);
  assert.match(body, /const surfaceDilationPasses = layerMode\s+\?\s+0\s+:\s+useStrokeMaskComposite\s+\?\s+0\s+:\s+projectedGutterTriangleCount > 0\s+\?\s+0\s+:\s+surfaceAirbrushDilationPasses\(\)/);
  assert.match(body, /runSurfaceDilation\([\s\S]*?surfaceDilationPasses,[\s\S]*?\{\s*preserveSourceAlpha: Boolean\(layerMode\)\s*\}/);
  assert.match(body, /tslSurfaceDilationPasses: finalTarget !== target \? surfaceDilationPasses : 0/);
  assert.match(dilationBody, /passCount = surfaceAirbrushDilationPasses\(\),\s*options = \{\}/);
  assert.match(dilationBody, /const passes = Math\.max\(0, Math\.floor\(finiteNumber\(passCount/);
  assert.match(dilationSeedBody, /options = \{\}/);
  assert.match(dilationSeedBody, /const preserveSourceAlpha = options\.preserveSourceAlpha === true/);
  assert.match(dilationSeedBody, /return vec4\(color\.rgb, preserveSourceAlpha \? color\.a : mask\.r\)/);
  assert.match(dilationSeedBody, /transparent: true/);
  assert.match(dilationSeedBody, /blending: THREE\.NoBlending/);
  assert.doesNotMatch(updateDilationSeedBody, /preserveSourceAlpha\.value/);
  assert.match(ensureDilationBody, /cache\.dilationSeedAlphaMaterial \|\|= createDilationSeedMaterial\([\s\S]*?preserveSourceAlpha: true/);
  assert.match(dilationBody, /const seedMaterial = options\.preserveSourceAlpha === true[\s\S]*?cache\.dilationSeedAlphaMaterial[\s\S]*?: cache\.dilationSeedMaterial/);
  assert.match(source, /const TSL_SURFACE_DILATION_SAMPLE_RADII = \[1, 2, 4, 8, 16\]/);
  assert.match(dilationMaterialBody, /TSL_SURFACE_DILATION_SAMPLE_RADII\.flatMap/);
  assert.match(dilationMaterialBody, /transparent: true/);
  assert.match(dilationMaterialBody, /blending: THREE\.NoBlending/);
});

test("TSL surface airbrush prewarms the same seam-bleed live source raster", () => {
  const body = functionSource("texturePaintPrewarmTslSurfaceAirbrush");
  assert.match(body, /const layerCoordinateReferenceTexture = layerMode[\s\S]*?layerBaseTexture \|\| materialOriginalMap \|\| material\.map \|\| editable\.texture/);
  assert.match(body, /ensureSurfaceAirbrushCache\(editor, editable, coordinateReferenceTexture \|\| referenceTexture, width, height\)/);
  assert.match(body, /const prewarmBaseTexture = layerSourceEmpty[\s\S]*?surfaceAirbrushTransparentTexture\(\)[\s\S]*?: sourceTexture/);
  assert.match(body, /const prewarmTargetIndex = -1/);
  assert.match(body, /const prewarmTarget = ensureSurfacePrewarmTarget\([\s\S]*?cache,[\s\S]*?width,[\s\S]*?height,[\s\S]*?coordinateReferenceTexture \|\| referenceTexture \|\| prewarmBaseTexture[\s\S]*?\)/);
  assert.match(body, /const prewarmWriteTexture = prewarmTarget\?\.texture \|\| prewarmBaseTexture/);
  assert.match(body, /const prewarmStrokeMaskTarget = ensureSurfacePrewarmStrokeMaskTarget\(cache, width, height\)/);
  assert.match(body, /const prewarmRasterWriteTexture = prewarmStrokeMaskTarget\?\.texture \|\| prewarmWriteTexture/);
  assert.match(body, /const usePrewarmSourceRasterClip = !layerMode && surfaceAirbrushSourceRasterClipEnabled\(\)/);
  assert.match(body, /const prewarmRasterClipPath = usePrewarmSourceRasterClip[\s\S]*?\? simplifiedSourceRasterClipSegments\(prewarmSegments, 18\)[\s\S]*?: \[\]/);
  assert.match(body, /ensureUvOccupancyMask\([\s\S]*?prewarmRasterWriteTexture,[\s\S]*?width,[\s\S]*?height/);
  assert.match(body, /const prewarmOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled\(\)/);
  assert.match(body, /ensureUvRasterMeshes\([\s\S]*?prewarmBaseTexture,[\s\S]*?\{\s*\.\.\.materialScopeOptions,[\s\S]*?originalMeshUvRaster: prewarmOriginalMeshUvRaster,[\s\S]*?sourceRasterGutterPixels: surfaceAirbrushSourceRasterGutterPixels\(\),[\s\S]*?sourceRasterClipSegments: prewarmRasterClipPath,[\s\S]*?sourceRasterClipHardness: finiteNumber\(options\.hardness,[\s\S]*?maskOnly: true,[\s\S]*?sourceRasterClipPaddingPixels: Math\.max\([\s\S]*?writeTexture: prewarmRasterWriteTexture,[\s\S]*?sampleTexture: prewarmBaseTexture[\s\S]*?\}/);
  assert.match(body, /clearSurfacePrewarmStrokeMaskTarget\(renderer, cache\)/);
  assert.match(body, /renderSurfaceStrokeComposite\([\s\S]*?prewarmTarget,[\s\S]*?prewarmBaseTexture,[\s\S]*?strokeMaskTarget\.texture/);
  const prewarmMaskBlockStart = body.indexOf("const prewarmStrokeMaskTarget = ensureSurfacePrewarmStrokeMaskTarget");
  const prewarmMaskBlockEnd = body.indexOf("const meshUvTriangleCount", prewarmMaskBlockStart);
  assert.notEqual(prewarmMaskBlockStart, -1);
  assert.notEqual(prewarmMaskBlockEnd, -1);
  const prewarmMaskBlock = body.slice(prewarmMaskBlockStart, prewarmMaskBlockEnd);
  assert.doesNotMatch(prewarmMaskBlock, /cache\.strokeMaskInitialized = false/);
  assert.doesNotMatch(prewarmMaskBlock, /ensureSurfaceStrokeMaskTarget\(cache, width, height\)/);
  assert.doesNotMatch(prewarmMaskBlock, /clearSurfaceStrokeMaskTarget\(renderer, cache\)/);
  assert.match(body, /sourceRasterClipSegments: prewarmRasterClipPath/);
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
  assert.match(body, /target: ensureSurfacePrewarmDisplayTarget\(/);
  const runBody = functionSource("texturePaintRunTslSurfaceAirbrush");
  assert.match(runBody, /const useOriginalMeshUvRaster = surfaceAirbrushOriginalMeshUvRasterEnabled\(\)/);
  assert.doesNotMatch(runBody, /const useOriginalMeshUvRaster = layerMode[\s\S]*?\? false/);
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
  assert.match(renderDisplayBody, /options\.target \|\| ensureSurfaceDisplayTarget/);
  assert.match(renderDisplayBody, /avoidTextures: options\.avoidTextures/);
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
  const compositeBody = functionSource("createLayerCompositeMaterial");
  const updateCompositeBody = functionSource("updateLayerCompositeMaterial");
  assert.match(body, /const layerCoordinateReferenceTexture = layerMode[\s\S]*?layerBaseTexture \|\| materialOriginalMap \|\| material\.map \|\| editable\.texture/);
  assert.match(body, /let coordinateReferenceTexture = layerMode[\s\S]*?\(layerCoordinateReferenceTexture \|\| referenceTexture\)/);
  assert.match(body, /ensureSurfaceAirbrushCache\(editor, editable, coordinateReferenceTexture \|\| referenceTexture, width, height\)/);
  assert.match(body, /cache\.strokeBaseTexture = surfaceStrokeStartBaseTexture\(cache, sourceTexture\)/);
  assert.match(body, /texturePaintTslSurfaceDisplayFlipY = \(coordinateReferenceTexture \|\| referenceTexture\)\?\.flipY === true/);
  assert.match(body, /renderSurfaceLayerComposite\([\s\S]*?displayBaseTexture \|\| coordinateReferenceTexture \|\| referenceTexture/);
  assert.match(body, /renderSurfaceLayerComposite\([\s\S]*?\{ alphaFallback: true \}/);
  assert.match(baseBody, /const stableBase = userData\.clonePaintTexture[\s\S]*?userData\.textureAirbrushWebGpuCanvasMap[\s\S]*?originalMap/);
  assert.match(baseBody, /editable\?\.layerMode === true[\s\S]*?return stableBase/);
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

test("TSL layer invalidation preserves static UV raster caches between strokes", () => {
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
  assert.match(pointerDownBody, /this\.texturePaintTslSurfaceAirbrushInvalidate\?\.\(\)/);
  assert.match(resetBody, /cache\.currentTexture = null/);
  assert.match(resetBody, /cache\.strokeBaseTexture = null/);
  assert.match(resetBody, /cache\.strokeMaskInitialized = false/);
  assert.doesNotMatch(resetBody, /uvOccupancyKey/);
  assert.doesNotMatch(resetBody, /surfaceMeshes/);
  assert.doesNotMatch(resetBody, /disposeUvRasterEntries/);
});

test("TSL source-mesh raster caches are stable across ping-pong texture identities", () => {
  const rasterKeyBody = functionSource("sourceUvRasterGeometryKey");
  const occupancyKeyBody = functionSource("sourceUvOccupancyKey");
  const occupancyObjectKeyBody = functionSource("sourceObjectUvCoverageKey");
  const projectionFrameKeyBody = functionSource("surfaceProjectionFrameKey");
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
  assert.match(body, /const compositedLayerAlpha = clamp\(alpha\.add\(baseColor\.a\.mul\(oneMinusAlpha\)\), 0\.0, 1\.0\)/);
  assert.match(body, /const emptyLayer = emptyLayerSource\.greaterThan\(0\.5\)\.toVar\(\)/);
  assert.match(body, /const layerOutAlpha = emptyLayer\.select\(alpha, compositedLayerAlpha\)\.toVar\(\)/);
  assert.match(body, /const layerColor = vec4\(storedLayerRgb\.x, storedLayerRgb\.y, storedLayerRgb\.z, layerOutAlpha\)\.toVar\(\)/);
  assert.match(body, /if \(layerOnly\) \{[\s\S]*?return layerColor/);
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
  assert.match(body, /const compositedLayerAlpha = clamp\(alpha\.add\(baseColor\.a\.mul\(oneMinusAlpha\)\), 0\.0, 1\.0\)/);
  assert.match(body, /const emptyLayer = emptyLayerSource\.greaterThan\(0\.5\)\.toVar\(\)/);
  assert.match(body, /const layerOutAlpha = emptyLayer\.select\(alpha, compositedLayerAlpha\)\.toVar\(\)/);
  assert.match(body, /const storedLayerRgb = layerOutAlpha\.greaterThan\(0\.0001\)\.select\(layerOutRgb\.mul\(layerOutAlpha\), vec3\(0\)\)\.toVar\(\)/);
  assert.match(body, /const brushOnlyColor = vec4\(storedLayerRgb\.x, storedLayerRgb\.y, storedLayerRgb\.z, layerOutAlpha\)\.toVar\(\)/);
  assert.match(body, /if \(layerOnly\) \{[\s\S]*?return brushOnlyColor/);
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
  assert.match(source, /const MAX_TSL_SURFACE_STROKE_MASK_SIZE = 4096/);
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
  assert.match(body, /texturePaintTslSurfaceLastStrokeBaseCopy = cache\.strokeBaseTexture === sourceTexture[\s\S]*?\? "direct-source"[\s\S]*?: "stable-source"/);
  assert.match(compositeRunBody, /const clearTransparentBase = options\.emptyLayerSource === true/);
  assert.match(compositeRunBody, /clearRenderTargetTransparent\(renderer, target, cache\)/);
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
  assert.doesNotMatch(compositeBody, /const alpha = clamp\(max\(max\(mask\.r, mask\.g\), mask\.a\), 0\.0, 1\.0\)/);
  assert.match(compositeBody, /transparent: true/);
  assert.match(compositeBody, /blending: layerOnly \? THREE\.NoBlending : THREE\.CustomBlending/);
  assert.match(compositeBody, /if \(!layerOnly\) \{/);
  assert.match(compositeBody, /material\.blendSrc = THREE\.OneFactor/);
  assert.match(compositeBody, /material\.blendDst = THREE\.ZeroFactor/);
  assert.match(compositeBody, /material\.blendSrcAlpha = THREE\.OneFactor/);
  assert.match(compositeBody, /material\.blendDstAlpha = THREE\.ZeroFactor/);
  assert.match(compositeBody, /if \(layerOnly\) \{[\s\S]*?return brushOnlyColor/);
  assert.match(compositeBody, /return vec4\(mix\(baseColor\.rgb, brushColor\.rgb, alpha\), 1\)/);
  assert.match(materialBody, /const shaderSourceTexture = sourceTexture \|\| \(wantsBlendOnly[\s\S]*?surfaceAirbrushTransparentTexture\(\)[\s\S]*?: surfaceAirbrushWhiteMaskTexture\(\)\)/);
  assert.match(materialBody, /const shaderVisibleTexture = visibleTexture \|\| shaderSourceTexture/);
  assert.match(materialBody, /state\.sourceTextureNode\.value = shaderSourceTexture/);
  assert.match(materialBody, /state\.blendOnly\.value = wantsBlendOnly \? 1 : 0/);
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
  assert.match(body, /options\.neighborPaintSeed\?\.enabled !== true/);
  assert.match(body, /options\.largeLiveNeighborPaint !== true/);
  assert.match(body, /const collectProjectedSeamStrokeSegments = !skipProjectedSeamStrokeSegmentsForTslSurface/);
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

test("TSL surface brush coverage respects connected-component gated segments", () => {
  const projectedBody = functionSource("createProjectedSurfaceMaterial");
  const surfaceBody = functionSource("createSurfaceMaterial");
  for (const materialBody of [projectedBody, surfaceBody]) {
    assert.match(materialBody, /const segmentComponent = segmentComponents\.element\(i\)/);
    assert.match(materialBody, /const connectedComponentGate = paintComponent\.lessThan\(0\.5\)[\s\S]*?abs\(paintComponent\.sub\(segmentComponent\.x\)\)\.lessThan\(0\.5\)[\s\S]*?abs\(paintComponent\.sub\(segmentComponent\.y\)\)\.lessThan\(0\.5\)/);
    assert.match(materialBody, /const componentGate = visibleActive\.greaterThan\(0\.5\)[\s\S]*?\.select\(float\(1\), connectedComponentGate\)[\s\S]*?\.toVar\(\)/);
    assert.match(materialBody, /\.mul\(componentGate\)[\s\S]*?\.mul\(normalGate\)/);
  }
});

test("TSL surface airbrush does not stencil soft strokes through the visible-depth prepass", () => {
  const body = functionSource("texturePaintRunTslSurfaceAirbrush");
  const materialBody = functionSource("createSurfaceMaterial");
  const updateBody = functionSource("updateSurfaceMaterial");
  assert.match(body, /const needsVisibleSurfaceTexture = false/);
  assert.match(body, /const visibleTarget = null/);
  assert.doesNotMatch(body, /renderVisibleSurfaceTarget\(/);
  assert.match(updateBody, /state\.visibleSurfaceEnabled\.value = options\.debugVisibleSurfaceDepth === true && visibleTexture \? 1 : 0/);
  assert.match(updateBody, /state\.visibleNormalEdge\.value = debugParams\?\.has\("debugAirbrushNoNormalGate"\) === true[\s\S]*?\? 0[\s\S]*?: visibleEdgeMode === "hard" \|\| visibleEdgeMode === "soft" \? 1 : 0/);
  assert.match(body, /debugVisibleSurfaceDepth: needsVisibleSurfaceTexture/);
  assert.doesNotMatch(materialBody, /visibleDepthCoverage|visibleDepthSmoothFade|visibleDepthFade|visibleGateCoverage/);
  assert.match(materialBody, /const brushFieldCoverage = screenCoverage\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /visibleDepthGate|visibleBehindDepth/);
  assert.match(materialBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(normalGate\)[\s\S]*?\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /visiblePermission|visibleSoftPermission/);
  assert.doesNotMatch(materialBody, /strokeNormalGate|strokeNormalRamp|strokeNormalCoverage|strokeNormalPresence/);
  assert.doesNotMatch(materialBody, /const gatedCoverage = surfaceFieldCoverage[\s\S]*?\.mul\(depthPermission\)/);
  assert.doesNotMatch(materialBody, /bridgePermission/);
  assert.match(materialBody, /const normalGate = mix\(float\(1\), facingCoverage, visibleNormalEdge\)\.toVar\(\)/);
  assert.match(materialBody, /const facingCoverage = mix\(softFacingCoverage, hardFacingCoverage, hardVisibleEdge\)\.toVar\(\)/);
  assert.doesNotMatch(materialBody, /VISIBLE_SURFACE_DEPTH_GATE_/);
  assert.doesNotMatch(materialBody, /visibleRadius/);
  assert.doesNotMatch(materialBody, /viewRadius\.mul\(float\(0\.85\)/);
});

test("TSL surface airbrush visible-depth prepass uses the same material scope", () => {
  const body = functionSource("ensureVisibleSurfaceResources");
  const materialBody = functionSource("createVisibleSurfaceMaterial");
  assert.match(body, /surfaceRasterMaterialsForSourceObject/);
  assert.match(body, /cache\.visibleMaterial/);
  assert.match(body, /sourceObject === fallbackSourceObject \? fallbackMaterialIndex : null/);
  assert.match(materialBody, /normalView/);
  assert.match(materialBody, /const encodedNormalZ = clamp\(normalView\.z\.mul\(0\.5\)\.add\(0\.5\), 0\.0, 1\.0\)\.toVar\(\)/);
  assert.match(materialBody, /vec4\(positionView\.z\.mul\(-1\), encodedNormalZ, 0, 1\)/);
});

test("TSL original-mesh UV raster evaluates normals in the editor camera view", () => {
  const body = functionSource("createSurfaceMaterial");
  const originalMeshBranch = body.slice(body.indexOf("if (originalMeshUvRaster)"));
  assert.match(body, /normalWorldGeometry/);
  assert.match(originalMeshBranch, /const editorView = editorViewMatrix\.mul\(worldPosition\)\.xyz\.toVar\(\)/);
  assert.match(originalMeshBranch, /paintNormal\.assign\(normalWorldGeometry\.transformDirection\(editorViewMatrix\)\)/);
  assert.doesNotMatch(originalMeshBranch, /paintNormal\.assign\(normalViewGeometry\)/);
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
  assert.match(newStrokeBody, /const explicitReset = candidate\?\.strokeReset === true/);
  assert.ok(
    newStrokeBody.indexOf("const explicitReset = candidate?.strokeReset === true")
      < newStrokeBody.indexOf("if (surfaceStrokeSegmentsAlreadyCovered(cache, segments))"),
    "stroke resets must not be swallowed by duplicate segment checks"
  );
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
  assert.match(appendBody, /const startsNewStroke = surfaceStrokeStartsNewStroke\(cache, owner, candidate, options, segments\)/);
  assert.match(appendBody, /if \(!startsNewStroke && surfaceStrokeSegmentsAlreadyCovered\(cache, segments\)\) \{/);
  assert.ok(
    appendBody.indexOf("const startsNewStroke = surfaceStrokeStartsNewStroke(cache, owner, candidate, options, segments)")
      < appendBody.indexOf("if (!startsNewStroke && surfaceStrokeSegmentsAlreadyCovered(cache, segments))"),
    "append path must honor stroke reset before duplicate skipping"
  );
  assert.match(body, /const duplicateCoveredSegmentsBeforeReset = !surfaceStrokeOwnerChanged\(cache, strokeSourceOwner\)\s*\n\s*&& !startsNewSurfaceStroke\s*\n\s*&& surfaceStrokeSegmentsAlreadyCovered\(cache, segments\)/);
  assert.match(body, /const strokeOwnerChangedAtRunStart = surfaceStrokeOwnerChanged\(cache, strokeSourceOwner\)/);
  assert.match(body, /const strokeResetRequestedAtRunStart = surfaceStrokeResetRequested\(candidate, options\)/);
  assert.match(body, /let strokeMaskCleared = false/);
  assert.match(body, /clearSurfaceStrokeMaskTarget\(renderer, cache\);\s*\n\s*strokeMaskCleared = true;/);
  assert.match(body, /tslSurfaceStartsNewStroke: startsNewSurfaceStroke/);
  assert.match(body, /tslSurfaceStrokeResetRequested: strokeResetRequestedAtRunStart/);
  assert.match(body, /tslSurfaceStrokeSourceOwner: Boolean\(strokeSourceOwner\)/);
  assert.match(body, /tslSurfaceStrokeOwnerChanged: strokeOwnerChangedAtRunStart/);
  assert.match(body, /tslSurfaceDuplicateCoveredSegments: duplicateCoveredSegments/);
  assert.match(body, /tslSurfaceStrokeMaskCleared: strokeMaskCleared/);
  assert.match(body, /tslSurfaceStartsNewStroke: startsNewSurfaceStroke,[\s\S]*?tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(body, /tslSurfaceStrokeSourceOwner: Boolean\(strokeSourceOwner\),[\s\S]*?tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(body, /tslSurfaceStrokeMaskCleared: false,[\s\S]*?tslSurfaceSkippedDuplicateSegments: true/);
  assert.match(body, /cache\.strokeBaseTexture = null/);
  assert.match(body, /cache\.strokeBaseTexture = surfaceStrokeStartBaseTexture\(cache, sourceTexture\)/);
  assert.match(body, /const baseTexture = cache\.strokeBaseTexture \|\| sourceTexture/);
  assert.match(strokeBaseBody, /surfaceAirbrushCacheOwnsTexture\(cache, sourceTexture\)/);
  assert.doesNotMatch(body, /direct-paint-target/);
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
  assert.match(runBody, /surfaceAirbrushReferenceTexture\(material, editable, materialOriginalMap, cache\)/);
  assert.match(runBody, /surfaceAirbrushCacheOwnsTexture\(cache, cache\.currentTexture\)/);
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
  assert.match(body, /surfaceStrokeUncoveredSegments\(outputSegments, segments\)/);
  assert.match(body, /const firstSegment = segmentsToAppend\[0\] \|\| null/);
  assert.match(body, /outputSegments\.push\(\.\.\.segmentsToAppend\)/);
  assert.doesNotMatch(body, /outputSegments\.push\(\.\.\.segments\)/);
});
