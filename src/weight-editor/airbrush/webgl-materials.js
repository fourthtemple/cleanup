import { TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS } from "./constants.js";
import {
  TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD,
  TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE,
  TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE,
  TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE,
  TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE
} from "./math.js";

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
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NormalBlending,
        uniforms: {
          paintViewMatrix: { value: new THREE.Matrix4() },
          paintProjectionMatrix: { value: new THREE.Matrix4() },
          depthTexture: { value: null },
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
          depthEpsilon: { value: 0.006 },
          strokeSourceTexture: { value: null },
          useStrokeSourceTexture: { value: false },
          currentTargetTexture: { value: null },
          useCurrentTargetTexture: { value: false },
          strokeSourceClear: { value: false },
          eraseMode: { value: false },
          useNeighborMask: { value: false },
          useNeighborNormalMask: { value: false },
          neighborSeedNormal: { value: makeVector3(0, 0, 1) },
          neighborNormalThreshold: { value: 0 },
          neighborViewNormalThreshold: { value: 0.18 },
          paintOccludedNeighborFragments: { value: false }
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
          varying vec4 vPaintClip;
          varying float vNeighborMask;
          varying vec3 vPaintObjectNormal;
          varying vec3 vPaintViewNormal;

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
            vPaintClip = paintProjectionMatrix * paintViewMatrix * worldPosition;
            vec2 targetUv = uv + uvOffset;
            gl_Position = vec4(targetUv.x * 2.0 - 1.0, targetUv.y * 2.0 - 1.0, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          #include <common>
          #define MAX_STROKE_SEGMENTS ${TEXTURE_AIRBRUSH_MAX_STROKE_SEGMENTS}
          uniform sampler2D depthTexture;
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
          uniform float depthEpsilon;
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
          uniform float neighborViewNormalThreshold;
          uniform bool paintOccludedNeighborFragments;
          varying vec2 vPaintUv;
          varying vec4 vPaintClip;
          varying float vNeighborMask;
          varying vec3 vPaintObjectNormal;
          varying vec3 vPaintViewNormal;

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
            if (
              useNeighborMask
              && useNeighborNormalMask
              && dot(normalize(vPaintObjectNormal), normalize(neighborSeedNormal)) < neighborNormalThreshold
            ) {
              discard;
            }
            if (
              useNeighborMask
              && paintOccludedNeighborFragments
              && normalize(vPaintViewNormal).z < neighborViewNormalThreshold
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
            float sceneDepth = texture2D(depthTexture, depthUv).r;
            float fragmentDepth = ndc.z * 0.5 + 0.5;
            if (
              sceneDepth < 0.9999
              && fragmentDepth > sceneDepth + depthEpsilon
              && !(useNeighborMask && paintOccludedNeighborFragments)
            ) {
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
            if (alpha <= ${TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD}) {
              discard;
            }
            if (useStrokeSourceTexture) {
              vec4 sourceColor = strokeSourceClear
                ? vec4(0.0)
                : texture2D(strokeSourceTexture, vPaintUv);
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
                vec4 currentColor = texture2D(currentTargetTexture, vPaintUv);
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
