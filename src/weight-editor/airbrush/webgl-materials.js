import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import {
  TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD,
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE
} from "./math.js";

// AIRBRUSH VISIBILITY INVARIANT:
// DO NOT PAINT ON NON CAMERA FACING SIDES.
// DO NOT PAINT ON NON CAMERA FACING SIDES in normal airbrush mode.
// DO NOT PAINT ON NON CAMERA FACING SIDES in Neighbor airbrush mode.
// DO NOT PAINT ON NON CAMERA FACING SIDES in layer airbrush mode.
// DO NOT PAINT ON NON CAMERA FACING SIDES to fix coverage holes.
// DO NOT PAINT ON NON CAMERA FACING SIDES after orbit/camera changes.
// DO NOT PAINT ON NON CAMERA FACING SIDES through UV bleed offsets.
// DO NOT PAINT ON NON CAMERA FACING SIDES through hidden/back fragments.
// DO NOT PAINT ON NON CAMERA FACING SIDES by loosening depth checks.
// Airbrushing must remain visible-surface only. Paint is allowed only on the
// current rendered frontmost visible field. This applies with and without
// Neighbor mode.
//
// USER-APPROVED FIX, DO NOT SIMPLIFY:
// DO NOT PAINT ON NON CAMERA FACING SIDES.
// DO NOT PAINT ON NON CAMERA FACING SIDES.
// DO NOT PAINT ON NON CAMERA FACING SIDES.
// This shader intentionally uses BOTH visibility gates:
// 1. camera-facing geometric normal gate, so back-facing triangles are never eligible;
// 2. exact frontmost depth-buffer match, so hidden/behind/ahead fragments are never eligible.
// Removing either gate can make the brush look more filled, but that is the
// forbidden failure mode: painting through the model or onto the back side.
const TEXTURE_AIRBRUSH_VISIBLE_ONLY_DEPTH_EPSILON = 0.00018;
// DO NOT PAINT ON NON CAMERA FACING SIDES.
// The back/behind tolerance above stays strict. This separate front tolerance
// only absorbs sub-pixel depth disagreement where the UV paint fragment projects
// a hair in front of the sampled visible depth while its normal still matches
// the current frontmost visible surface. It is capped; do not turn it into the
// old unbounded "closer than depth is okay" shortcut, because that paints around
// the back at wraps.
const TEXTURE_AIRBRUSH_VISIBLE_ONLY_FRONT_DEPTH_EPSILON = 0.0008;
// DO NOT PAINT ON NON CAMERA FACING SIDES.
// This small negative value is only a visible-silhouette tolerance for meshes
// whose smoothed/vertex normals tip just past 90 degrees while the triangle is
// still the frontmost rendered surface. It is not a hidden-side allowance:
// the strict depth gate and visible-normal agreement gate below still decide
// whether the fragment belongs to the current camera-visible surface.
const TEXTURE_AIRBRUSH_VISIBLE_FACING_NORMAL_THRESHOLD = -0.12;
const TEXTURE_AIRBRUSH_VISIBLE_NORMAL_MATCH_THRESHOLD = 0.12;

export function installTextureAirbrushWebGlMaterialMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;
  const makeVector3 = (x = 0, y = 0, z = 0) => (
    typeof THREE.Vector3 === "function"
      ? new THREE.Vector3(x, y, z)
      : {
          x,
          y,
          z,
          set(nextX = 0, nextY = 0, nextZ = 0) {
            this.x = nextX;
            this.y = nextY;
            this.z = nextZ;
            return this;
          }
        }
  );
  const MIPMAP_FILTERS = new Set([
    THREE.NearestMipmapNearestFilter,
    THREE.NearestMipmapLinearFilter,
    THREE.LinearMipmapNearestFilter,
    THREE.LinearMipmapLinearFilter
  ].filter((value) => value !== undefined));

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushBrushShaderMaterial() {
      if (this.textureAirbrushGpuMaterial) {
        return this.textureAirbrushGpuMaterial;
      }
      this.textureAirbrushGpuMaterial = new THREE.ShaderMaterial({
        transparent: true,
        extensions: { derivatives: true },
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // DoubleSide is only for the UV-space render pass. Visibility is still
        // enforced below by the paint-normal, visible-normal, and depth gates.
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NormalBlending,
        uniforms: {
          paintViewMatrix: { value: new THREE.Matrix4() },
          paintProjectionMatrix: { value: new THREE.Matrix4() },
          depthTexture: { value: null },
          visibleNormalTexture: { value: null },
          useVisibleNormalTexture: { value: false },
          brushCenter: { value: new THREE.Vector2() },
          brushStart: { value: new THREE.Vector2() },
          strokeStarts: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => new THREE.Vector2()) },
          strokeEnds: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => new THREE.Vector2()) },
          strokeRadii: { value: Array.from({ length: TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS }, () => 8) },
          strokeSegmentCount: { value: 1 },
          viewportSize: { value: new THREE.Vector2(1, 1) },
          uvOffset: { value: new THREE.Vector2() },
          paintColor: { value: new THREE.Color(1, 1, 1) },
          radiusPixels: { value: 8 },
          strength: { value: 0.35 },
          brushOpacity: { value: 0.42 },
          brushHardness: { value: 0.35 },
          scatterAmount: { value: 0.35 },
          // DO NOT PAINT ON NON CAMERA FACING SIDES. All airbrush modes use a
          // visible-depth match. Never raise this to paint through, behind, or
          // around the visible side of the model.
          visibleOnlyDepthEpsilon: { value: TEXTURE_AIRBRUSH_VISIBLE_ONLY_DEPTH_EPSILON },
          // DO NOT PAINT ON NON CAMERA FACING SIDES. This is not hidden-side
          // permission; it only handles visible-edge depth quantization after
          // the visible-normal buffer proves the fragment is the same front
          // surface.
          visibleOnlyFrontDepthEpsilon: { value: TEXTURE_AIRBRUSH_VISIBLE_ONLY_FRONT_DEPTH_EPSILON },
          // DO NOT PAINT ON NON CAMERA FACING SIDES. Depth alone is not enough:
          // the painted surface normal must also face the paint camera.
          visibleFacingNormalThreshold: { value: TEXTURE_AIRBRUSH_VISIBLE_FACING_NORMAL_THRESHOLD },
          // DO NOT PAINT ON NON CAMERA FACING SIDES. The visible-normal buffer
          // is the front-surface authority at the current screen pixel; this
          // threshold prevents a nearly matching depth value from authorizing a
          // different wrap/back surface.
          visibleNormalMatchThreshold: { value: TEXTURE_AIRBRUSH_VISIBLE_NORMAL_MATCH_THRESHOLD },
          strokeSourceTexture: { value: null },
          useStrokeSourceTexture: { value: false },
          currentTargetTexture: { value: null },
          useCurrentTargetTexture: { value: false },
          strokeSourceClear: { value: false },
          eraseMode: { value: false },
          useNeighborMask: { value: false },
          useNeighborNormalMask: { value: false },
          neighborSeedNormal: { value: makeVector3(0, 0, 1) },
          neighborNormalThreshold: { value: 0 }
        },
        vertexShader: `
          #include <common>
          #include <uv_pars_vertex>
          #include <skinning_pars_vertex>
          uniform mat4 paintViewMatrix;
          uniform mat4 paintProjectionMatrix;
          uniform vec2 uvOffset;
          attribute float textureAirbrushNeighborMask;
          varying vec2 vPaintUv;
          varying vec2 vPaintTargetUv;
          varying vec4 vPaintClip;
          varying float vNeighborMask;
          varying vec3 vPaintObjectNormal;
          varying vec3 vPaintViewNormal;
          varying vec3 vPaintViewPosition;

          void main() {
            vPaintUv = uv;
            vNeighborMask = textureAirbrushNeighborMask;
            #include <beginnormal_vertex>
            #include <skinbase_vertex>
            #include <skinnormal_vertex>
            vPaintObjectNormal = normalize(objectNormal);
            vPaintViewNormal = normalize(mat3(paintViewMatrix * modelMatrix) * objectNormal);
            vec3 transformed = position;
            #include <skinning_vertex>
            vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
            vPaintViewPosition = (paintViewMatrix * worldPosition).xyz;
            vPaintClip = paintProjectionMatrix * paintViewMatrix * worldPosition;
            vec2 targetUv = uv + uvOffset;
            vPaintTargetUv = targetUv;
            gl_Position = vec4(targetUv.x * 2.0 - 1.0, targetUv.y * 2.0 - 1.0, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          #include <common>
          #define MAX_STROKE_SEGMENTS ${TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS}
          uniform sampler2D depthTexture;
          uniform sampler2D visibleNormalTexture;
          uniform bool useVisibleNormalTexture;
          uniform vec2 brushCenter;
          uniform vec2 brushStart;
          uniform vec2 strokeStarts[MAX_STROKE_SEGMENTS];
          uniform vec2 strokeEnds[MAX_STROKE_SEGMENTS];
          uniform float strokeRadii[MAX_STROKE_SEGMENTS];
          uniform int strokeSegmentCount;
          uniform vec2 viewportSize;
          uniform vec3 paintColor;
          uniform float radiusPixels;
          uniform float strength;
          uniform float brushOpacity;
          uniform float brushHardness;
          uniform float scatterAmount;
          uniform float visibleOnlyDepthEpsilon;
          uniform float visibleOnlyFrontDepthEpsilon;
          uniform float visibleFacingNormalThreshold;
          uniform float visibleNormalMatchThreshold;
          uniform sampler2D strokeSourceTexture;
          uniform bool useStrokeSourceTexture;
          uniform sampler2D currentTargetTexture;
          uniform bool useCurrentTargetTexture;
          uniform bool strokeSourceClear;
          uniform bool eraseMode;
          uniform bool useNeighborMask;
          uniform bool useNeighborNormalMask;
          uniform vec3 neighborSeedNormal;
          uniform float neighborNormalThreshold;
          varying vec2 vPaintUv;
          // DO NOT PAINT ON NON CAMERA FACING SIDES.
          // Offset UVs are allowed only for sampling the same visible fragment.
          // They must never become a bleed pass that paints hidden UV islands.
          varying vec2 vPaintTargetUv;
          varying vec4 vPaintClip;
          varying float vNeighborMask;
          varying vec3 vPaintObjectNormal;
          varying vec3 vPaintViewNormal;
          varying vec3 vPaintViewPosition;

          vec3 paintFragmentViewNormal() {
            vec3 viewNormal = normalize(vPaintViewNormal);
            if (length(viewNormal) > 0.000001) {
              return viewNormal;
            }
            vec3 geometricNormal = cross(dFdx(vPaintViewPosition), dFdy(vPaintViewPosition));
            geometricNormal *= gl_FrontFacing ? 1.0 : -1.0;
            float geometricLength = length(geometricNormal);
            if (geometricLength > 0.000001) {
              return normalize(geometricNormal);
            }
            return vec3(0.0, 0.0, -1.0);
          }

          bool visibleSurfaceDepthNormalMatch(vec2 sampleUv, float fragmentDepth, vec3 paintViewNormal, float normalMatchThreshold) {
            if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
              return false;
            }
            float sceneDepth = texture2D(depthTexture, sampleUv).r;
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Background depth is not a visible model surface. Neighboring
            // samples are only allowed to rescue edge quantization when they
            // still point at the current rendered front surface.
            if (sceneDepth >= 0.9999) {
              return false;
            }
            float deltaFromVisibleSurface = fragmentDepth - sceneDepth;
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Keep both sides bounded: this helper does not restore the old
            // "closer than depth is okay" shortcut and it does not widen the
            // strict behind/back-side depth gate.
            if (
              deltaFromVisibleSurface > visibleOnlyDepthEpsilon
              || deltaFromVisibleSurface < -visibleOnlyFrontDepthEpsilon
            ) {
              return false;
            }
            if (useVisibleNormalTexture) {
              vec3 visibleNormal = texture2D(visibleNormalTexture, sampleUv).rgb * 2.0 - 1.0;
              float visibleNormalLength = length(visibleNormal);
              if (visibleNormalLength <= 0.000001) {
                return false;
              }
              visibleNormal = visibleNormal / visibleNormalLength;
              // DO NOT PAINT ON NON CAMERA FACING SIDES.
              // A nearby depth sample is useful only when its frontmost normal
              // still agrees with this paint fragment. This prevents edge
              // rescue from authorizing a wrap/back fragment that merely has a
              // similar depth value.
              if (dot(visibleNormal, paintViewNormal) < normalMatchThreshold) {
                return false;
              }
            }
            return true;
          }

          float visibleSurfaceGaussianCoverage(vec2 sampleUv, float fragmentDepth, vec3 paintViewNormal, float normalMatchThreshold) {
            vec2 screenPixel = 1.0 / max(viewportSize, vec2(1.0));
            float coverage = 0.0;
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This is a tiny Gaussian-style visibility feather, not a blur pass
            // over the paint texture. Every weighted sample must pass the same
            // visible-depth and visible-normal checks before it can contribute.
            coverage += visibleSurfaceDepthNormalMatch(sampleUv, fragmentDepth, paintViewNormal, normalMatchThreshold) ? 4.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(screenPixel.x, 0.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - vec2(screenPixel.x, 0.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(0.0, screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - vec2(0.0, screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + screenPixel, fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(screenPixel.x, -screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(-screenPixel.x, screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - screenPixel, fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            return clamp(coverage / 16.0, 0.0, 1.0);
          }

          float visibleSurfaceWideGaussianCoverage(vec2 sampleUv, float fragmentDepth, vec3 paintViewNormal, float normalMatchThreshold) {
            vec2 screenPixel = 1.0 / max(viewportSize, vec2(1.0));
            float coverage = 0.0;
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This wider kernel is only for already center-visible fragments at
            // grazing local boundaries. It smooths the visual falloff; it must
            // never authorize a hidden/back fragment by itself.
            coverage += visibleSurfaceDepthNormalMatch(sampleUv, fragmentDepth, paintViewNormal, normalMatchThreshold) ? 8.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(screenPixel.x, 0.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 4.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - vec2(screenPixel.x, 0.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 4.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(0.0, screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 4.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - vec2(0.0, screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 4.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + screenPixel, fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(screenPixel.x, -screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(-screenPixel.x, screenPixel.y), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - screenPixel, fragmentDepth, paintViewNormal, normalMatchThreshold) ? 2.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(screenPixel.x * 2.0, 0.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - vec2(screenPixel.x * 2.0, 0.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv + vec2(0.0, screenPixel.y * 2.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            coverage += visibleSurfaceDepthNormalMatch(sampleUv - vec2(0.0, screenPixel.y * 2.0), fragmentDepth, paintViewNormal, normalMatchThreshold) ? 1.0 : 0.0;
            return clamp(coverage / 36.0, 0.0, 1.0);
          }

          float visibleSurfaceGrazingEdgeAmount(vec3 paintViewNormal) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This angle test only decides whether an already-visible local
            // boundary should ease out like an airbrush. It is paired with the
            // 3x3 visible-depth kernel, so folds/interior seams keep full paint
            // unless they also look like the current camera-visible wrap edge.
            float grazingStart = visibleFacingNormalThreshold + 0.06;
            float grazingEnd = visibleFacingNormalThreshold + 0.42;
            return 1.0 - smoothstep(grazingStart, grazingEnd, paintViewNormal.z);
          }

          float visibleSurfaceGrazingAngleCoverage(vec3 paintViewNormal) {
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This is only an alpha floor for fragments that already passed the
            // center visible-surface gates. It smooths the 90-degree falloff by
            // angle so the screen-sample Gaussian cannot leave a comb of hard
            // triangle-sized notches along an otherwise visible side edge.
            float grazingFeatherEnd = visibleFacingNormalThreshold + 0.28;
            return smoothstep(visibleFacingNormalThreshold, grazingFeatherEnd, paintViewNormal.z);
          }

          float strokePaintProgress(vec4 color, vec4 sourceColor, bool erasing) {
            if (erasing) {
              return clamp((sourceColor.a - color.a) / max(0.0001, sourceColor.a), 0.0, 1.0);
            }
            vec3 paintDelta = paintColor - sourceColor.rgb;
            vec3 colorDelta = color.rgb - sourceColor.rgb;
            float colorDenom = dot(paintDelta, paintDelta);
            float colorProgress = colorDenom > 0.0001
              ? dot(colorDelta, paintDelta) / colorDenom
              : 0.0;
            float alphaProgress = sourceColor.a < 0.9999
              ? (color.a - sourceColor.a) / max(0.0001, 1.0 - sourceColor.a)
              : 0.0;
            if (sourceColor.a < 0.9999) {
              return clamp(alphaProgress, 0.0, 1.0);
            }
            return clamp(colorProgress, 0.0, 1.0);
          }

          void main() {
            if (useNeighborMask && vNeighborMask < 0.5) {
              discard;
            }
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // KEEP THIS GATE. It is half of the approved visible-only fix.
            // Do not replace it with depth-only logic; depth matching can
            // still let near-wrap UV fragments receive paint around the back.
            // Do not make this Neighbor-only. Normal airbrush, Neighbor, and
            // layer airbrush all share the same visible-side-only rule.
            // The smoothed paint normal gives a hard, non-faceted cutoff; the
            // visible-normal buffer below makes sure that cutoff belongs to the
            // current frontmost visible surface, not a hidden wrap surface.
            //
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This is global airbrush behavior, not a Neighbor-only rule:
            // fragments whose paint normal faces away from the paint camera
            // are not eligible for paint. This is not permission to paint
            // through or behind the model; the visible-normal and depth gates
            // below must still agree with the current frontmost screen surface.
            vec3 paintViewNormal = paintFragmentViewNormal();
            if (paintViewNormal.z <= visibleFacingNormalThreshold) {
              discard;
            }
            if (
              useNeighborMask
              && useNeighborNormalMask
              && dot(normalize(vPaintObjectNormal), normalize(neighborSeedNormal)) < neighborNormalThreshold
            ) {
              discard;
            }
            if (vPaintClip.w <= 0.0) {
              discard;
            }
            vec3 ndc = vPaintClip.xyz / vPaintClip.w;
            if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
              discard;
            }
            vec2 depthUv = ndc.xy * 0.5 + 0.5;
            float fragmentDepth = ndc.z * 0.5 + 0.5;
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // KEEP THIS GATE. It is the other half of the approved visible-only
            // fix. The normal gate rejects back-facing triangles; this depth
            // gate rejects fragments that are not the current rendered front
            // surface at this screen pixel. The behind/back-side side remains
            // intentionally strict: "closer than depth" is not visible-surface
            // proof at a wrap.
            //
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Do not widen this into "paint anything close enough behind the
            // surface" or "anything closer than depth," and do not add a
            // Neighbor exception. Coverage holes must be fixed by warming/
            // refreshing projection state, not by painting through the model.
            //
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // The airbrush paints only the visible field. If the depth buffer
            // has background at this screen pixel, there is no visible model
            // surface here and no texture fragment may receive paint.
            //
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Neighbor mode is also visible-field-only. Do not "fix" Neighbor
            // holes by painting the non-visible side, the back of the leg, or
            // any fragment hidden behind the frontmost scene depth.
            //
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // This is global, not a Neighbor special case: no airbrush mode is
            // allowed to paint non-visible, back-side, hidden, or through-object
            // fragments. A painted texture fragment must depth-match the
            // frontmost visible scene surface at the same screen pixel. A small,
            // bounded front-side epsilon is allowed only after the visible-normal
            // check above agrees with the current front surface; behind/back-side
            // fragments still use the strict epsilon and must be rejected.
            // Do not restore the old unbounded "closer than depth is okay" shortcut.
            bool visibleSurfaceMatched = visibleSurfaceDepthNormalMatch(
              depthUv,
              fragmentDepth,
              paintViewNormal,
              visibleNormalMatchThreshold
            );
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // Center-visible fragments are already proven visible. Near the
            // 90-degree normal cutoff they still need a continuous airbrush
            // fade; otherwise a fully matched triangle can paint at full alpha
            // until it suddenly discards and leaves a hard angular cutoff.
            float visibleSurfaceCoverage = 1.0;
            if (visibleSurfaceMatched && useVisibleNormalTexture) {
              float boundaryCoverage = visibleSurfaceGaussianCoverage(
                depthUv,
                fragmentDepth,
                paintViewNormal,
                visibleNormalMatchThreshold
              );
              float grazingEdgeAmount = visibleSurfaceGrazingEdgeAmount(paintViewNormal);
              if (grazingEdgeAmount > 0.0) {
                float grazingAngleCoverage = visibleSurfaceGrazingAngleCoverage(paintViewNormal);
                float softBoundaryCoverage = grazingAngleCoverage;
                if (boundaryCoverage < 0.999) {
                  float wideBoundaryCoverage = visibleSurfaceWideGaussianCoverage(
                    depthUv,
                    fragmentDepth,
                    paintViewNormal,
                    visibleNormalMatchThreshold
                  );
                  // DO NOT PAINT ON NON CAMERA FACING SIDES.
                  // Near the 90-degree cutoff, the continuous angle falloff owns
                  // the opacity so a high neighboring sample cannot draw a comb
                  // of solid teeth. As the fragment turns more camera-facing, the
                  // visible-only sampled Gaussian is allowed to fill small raster
                  // gaps without authorizing any hidden/back fragments.
                  float sampledBoundaryCoverage = max(wideBoundaryCoverage, grazingAngleCoverage);
                  softBoundaryCoverage = mix(
                    grazingAngleCoverage,
                    sampledBoundaryCoverage,
                    grazingAngleCoverage
                  );
                }
                visibleSurfaceCoverage = mix(1.0, softBoundaryCoverage, grazingEdgeAmount);
              }
            }
            if (!visibleSurfaceMatched && useVisibleNormalTexture) {
              // DO NOT PAINT ON NON CAMERA FACING SIDES.
              // This is an edge rasterization repair only. At grazing visible
              // silhouettes, the UV-space fragment can land between depth
              // pixels even though the surface is visibly frontmost. Check the
              // immediate 8-connected screen neighbors so diagonal visible
              // edges do not become a staircase, but require a much stronger
              // visible normal match and keep the same strict depth windows.
              float edgeNormalMatchThreshold = max(0.55, visibleNormalMatchThreshold);
              visibleSurfaceCoverage = visibleSurfaceGaussianCoverage(
                depthUv,
                fragmentDepth,
                paintViewNormal,
                edgeNormalMatchThreshold
              );
              visibleSurfaceMatched = visibleSurfaceCoverage > 0.0;
            }
            if (!visibleSurfaceMatched) {
              discard;
            }
            vec2 screenPoint = vec2(
              (ndc.x * 0.5 + 0.5) * viewportSize.x,
              (-ndc.y * 0.5 + 0.5) * viewportSize.y
            );
            float scatter = clamp(scatterAmount, 0.0, 1.0);
            float coverage = 0.0;
            for (int strokeIndex = 0; strokeIndex < MAX_STROKE_SEGMENTS; strokeIndex++) {
              if (strokeIndex >= strokeSegmentCount) {
                break;
              }
              vec2 segmentStart = strokeStarts[strokeIndex];
              vec2 segmentEnd = strokeEnds[strokeIndex];
              float segmentRadius = max(1.0, strokeRadii[strokeIndex] > 0.0 ? strokeRadii[strokeIndex] : radiusPixels);
              float haloRadius = segmentRadius * (1.0 + scatter * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE});
              vec2 brushSegment = segmentEnd - segmentStart;
              float segmentLengthSq = dot(brushSegment, brushSegment);
              float segmentAlpha = segmentLengthSq > 0.0001
                ? clamp(dot(screenPoint - segmentStart, brushSegment) / segmentLengthSq, 0.0, 1.0)
                : 1.0;
              vec2 closestPoint = segmentStart + brushSegment * segmentAlpha;
              float distancePixels = distance(screenPoint, closestPoint);
              if (distancePixels <= haloRadius) {
                float hardness = clamp(brushHardness, 0.0, 1.0);
                float hardRadius = segmentRadius * hardness;
                float segmentCoverage = 1.0;
                if (distancePixels > hardRadius) {
                  float fadeRadius = max(1.0, haloRadius - hardRadius);
                  float edge = max(0.0, 1.0 - (distancePixels - hardRadius) / fadeRadius);
                  float exponent = ${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} - hardness * ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} + scatter * ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE};
                  segmentCoverage = min(1.0, pow(edge, exponent));
                }
                coverage = max(coverage, segmentCoverage);
              }
            }
            if (coverage <= 0.0) {
              discard;
            }
            float alpha = min(1.0, brushOpacity * strength * coverage);
            alpha *= visibleSurfaceCoverage;
            if (alpha <= ${TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD}) {
              discard;
            }
            if (useStrokeSourceTexture) {
              // DO NOT PAINT ON NON CAMERA FACING SIDES.
              // Stroke opacity snapshots must sample the same visible UV target
              // as the render pass. Sampling raw vPaintUv here can make a UV
              // offset/bleed pass compare against the wrong texel and revive
              // hidden-side paint.
              vec4 sourceColor = strokeSourceClear
                ? vec4(0.0)
                : texture2D(strokeSourceTexture, vPaintTargetUv);
              vec4 proposedColor;
              if (eraseMode) {
                proposedColor = vec4(sourceColor.rgb, sourceColor.a * (1.0 - alpha));
              } else {
                float nextAlpha = alpha + sourceColor.a * (1.0 - alpha);
                vec3 nextRgb = nextAlpha > 0.0001
                  ? (paintColor * alpha + sourceColor.rgb * sourceColor.a * (1.0 - alpha)) / nextAlpha
                  : vec3(0.0);
                proposedColor = vec4(nextRgb, nextAlpha);
              }
              if (useCurrentTargetTexture) {
                // DO NOT PAINT ON NON CAMERA FACING SIDES.
                // Current-target comparison also follows vPaintTargetUv so the
                // approved visible-only pass stays internally consistent.
                vec4 currentColor = texture2D(currentTargetTexture, vPaintTargetUv);
                float currentProgress = strokePaintProgress(currentColor, sourceColor, eraseMode);
                if (currentProgress + 0.0001 >= alpha) {
                  gl_FragColor = currentColor;
                  return;
                }
              }
              gl_FragColor = proposedColor;
              return;
            }
            gl_FragColor = vec4(paintColor, alpha);
          }
        `
      });
      return this.textureAirbrushGpuMaterial;
    },

    textureAirbrushVisibleSurfaceNormalMaterial() {
      if (this.textureAirbrushGpuVisibleNormalMaterial) {
        return this.textureAirbrushGpuVisibleNormalMaterial;
      }
      this.textureAirbrushGpuVisibleNormalMaterial = new THREE.ShaderMaterial({
        // DO NOT PAINT ON NON CAMERA FACING SIDES.
        // The normal buffer is rendered front-side only so it describes the
        // current camera-visible surface. It is sampled by the paint shader to
        // reject depth-close wrap/back fragments.
        side: THREE.FrontSide,
        depthTest: true,
        depthWrite: true,
        transparent: false,
        vertexShader: `
          #include <common>
          #include <skinning_pars_vertex>
          varying vec3 vAirbrushVisibleNormal;

          void main() {
            #include <beginnormal_vertex>
            #include <skinbase_vertex>
            #include <skinnormal_vertex>
            #include <defaultnormal_vertex>
            vAirbrushVisibleNormal = normalize(transformedNormal);
            vec3 transformed = position;
            #include <skinning_vertex>
            vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vAirbrushVisibleNormal;

          void main() {
            vec3 visibleNormal = normalize(vAirbrushVisibleNormal);
            // DO NOT PAINT ON NON CAMERA FACING SIDES.
            // The normal buffer stores only front-side rasterized surfaces
            // because this material renders with THREE.FrontSide and writes the
            // matching depth buffer. Do not add a smoothed-normal z cutoff here:
            // that can turn a continuous visible edge into triangle-ridge holes.
            // The paint shader still applies the paint fragment's camera-facing
            // normal gate before any paint can land.
            gl_FragColor = vec4(visibleNormal * 0.5 + 0.5, 1.0);
          }
        `
      });
      return this.textureAirbrushGpuVisibleNormalMaterial;
    },

    textureAirbrushNoopMaterial() {
      if (!this.textureAirbrushGpuNoopMaterial) {
        this.textureAirbrushGpuNoopMaterial = new THREE.ShaderMaterial({
          transparent: true,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          vertexShader: `
            void main() {
              gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
            }
          `,
          fragmentShader: `
            void main() {
              discard;
            }
          `
        });
      }
      return this.textureAirbrushGpuNoopMaterial;
    },

    textureAirbrushCopyMaterial(sourceTexture) {
      if (!this.textureAirbrushGpuCopyMaterial) {
        this.textureAirbrushGpuCopyMaterial = new THREE.MeshBasicMaterial({
          depthTest: false,
          depthWrite: false,
          blending: THREE.NoBlending,
          transparent: false
        });
      }
      this.textureAirbrushGpuCopyMaterial.map = sourceTexture;
      this.textureAirbrushGpuCopyMaterial.opacity = 1;
      this.textureAirbrushGpuCopyMaterial.transparent = false;
      if (THREE.NoBlending !== undefined) {
        this.textureAirbrushGpuCopyMaterial.blending = THREE.NoBlending;
      }
      this.textureAirbrushGpuCopyMaterial.needsUpdate = true;
      return this.textureAirbrushGpuCopyMaterial;
    },

    textureAirbrushRenderTextureSettings(sourceTexture) {
      const sourceMinFilter = sourceTexture?.minFilter || THREE.LinearFilter;
      const minFilter = MIPMAP_FILTERS.has(sourceMinFilter)
        ? THREE.LinearFilter
        : sourceMinFilter;
      return {
        minFilter,
        magFilter: sourceTexture?.magFilter || THREE.LinearFilter,
        wrapS: sourceTexture?.wrapS || THREE.ClampToEdgeWrapping,
        wrapT: sourceTexture?.wrapT || THREE.ClampToEdgeWrapping,
        generateMipmaps: false
      };
    },

    textureAirbrushCopyTextureRenderSettings(destinationTexture, sourceTexture) {
      if (!destinationTexture || !sourceTexture) {
        return false;
      }
      const settings = this.textureAirbrushRenderTextureSettings(sourceTexture);
      destinationTexture.colorSpace = sourceTexture.colorSpace;
      destinationTexture.flipY = sourceTexture.flipY;
      destinationTexture.minFilter = settings.minFilter;
      destinationTexture.magFilter = settings.magFilter;
      destinationTexture.wrapS = settings.wrapS;
      destinationTexture.wrapT = settings.wrapT;
      destinationTexture.generateMipmaps = settings.generateMipmaps;
      destinationTexture.anisotropy = sourceTexture.anisotropy || 1;
      destinationTexture.offset?.copy?.(sourceTexture.offset);
      destinationTexture.repeat?.copy?.(sourceTexture.repeat);
      destinationTexture.center?.copy?.(sourceTexture.center);
      destinationTexture.rotation = sourceTexture.rotation || 0;
      destinationTexture.matrixAutoUpdate = sourceTexture.matrixAutoUpdate !== false;
      if (destinationTexture.matrix && sourceTexture.matrix) {
        destinationTexture.matrix.copy(sourceTexture.matrix);
      }
      if (!destinationTexture.isRenderTargetTexture) {
        destinationTexture.needsUpdate = true;
      }
      return true;
    },

    textureAirbrushWithRawTextureMatrix(sourceTexture, callback) {
      if (!sourceTexture?.matrix || typeof callback !== "function") {
        return callback?.();
      }
      const previousMatrixAutoUpdate = sourceTexture.matrixAutoUpdate;
      const previousMatrix = sourceTexture.matrix.clone();
      sourceTexture.matrixAutoUpdate = false;
      sourceTexture.matrix.identity();
      try {
        return callback();
      } finally {
        sourceTexture.matrix.copy(previousMatrix);
        sourceTexture.matrixAutoUpdate = previousMatrixAutoUpdate;
      }
    }
  });
}
