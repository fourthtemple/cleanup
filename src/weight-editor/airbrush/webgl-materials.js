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
          strokeSegmentCount: { value: 1 },
          viewportSize: { value: new THREE.Vector2(1, 1) },
          uvOffset: { value: new THREE.Vector2() },
          paintColor: { value: new THREE.Color(1, 1, 1) },
          radiusPixels: { value: 8 },
          strength: { value: 0.35 },
          brushOpacity: { value: 0.42 },
          brushHardness: { value: 0.35 },
          scatterAmount: { value: 0.35 },
          depthEpsilon: { value: 0.006 }
        },
        vertexShader: `
          #include <common>
          #include <uv_pars_vertex>
          #include <skinning_pars_vertex>
          uniform mat4 paintViewMatrix;
          uniform mat4 paintProjectionMatrix;
          uniform vec2 uvOffset;
          varying vec2 vPaintUv;
          varying vec4 vPaintClip;

          void main() {
            vPaintUv = uv;
            vec3 transformed = position;
            #include <skinbase_vertex>
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
          uniform int strokeSegmentCount;
          uniform vec2 viewportSize;
          uniform vec3 paintColor;
          uniform float radiusPixels;
          uniform float strength;
          uniform float brushOpacity;
          uniform float brushHardness;
          uniform float scatterAmount;
          uniform float depthEpsilon;
          varying vec2 vPaintUv;
          varying vec4 vPaintClip;

          void main() {
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
            if (sceneDepth < 0.9999 && fragmentDepth > sceneDepth + depthEpsilon) {
              discard;
            }
            vec2 screenPoint = vec2(
              (ndc.x * 0.5 + 0.5) * viewportSize.x,
              (-ndc.y * 0.5 + 0.5) * viewportSize.y
            );
            float scatter = clamp(scatterAmount, 0.0, 1.0);
            float haloRadius = radiusPixels * (1.0 + scatter * ${TEXTURE_AIRBRUSH_SCATTER_HALO_SCALE});
            float distancePixels = 100000.0;
            for (int strokeIndex = 0; strokeIndex < MAX_STROKE_SEGMENTS; strokeIndex++) {
              if (strokeIndex >= strokeSegmentCount) {
                break;
              }
              vec2 segmentStart = strokeStarts[strokeIndex];
              vec2 segmentEnd = strokeEnds[strokeIndex];
              vec2 brushSegment = segmentEnd - segmentStart;
              float segmentLengthSq = dot(brushSegment, brushSegment);
              float segmentAlpha = segmentLengthSq > 0.0001
                ? clamp(dot(screenPoint - segmentStart, brushSegment) / segmentLengthSq, 0.0, 1.0)
                : 1.0;
              vec2 closestPoint = segmentStart + brushSegment * segmentAlpha;
              distancePixels = min(distancePixels, distance(screenPoint, closestPoint));
            }
            if (distancePixels > haloRadius) {
              discard;
            }
            float hardness = clamp(brushHardness, 0.0, 1.0);
            float hardRadius = radiusPixels * hardness;
            float coverage = 1.0;
            if (distancePixels > hardRadius) {
              float fadeRadius = max(1.0, haloRadius - hardRadius);
              float edge = max(0.0, 1.0 - (distancePixels - hardRadius) / fadeRadius);
              float exponent = ${TEXTURE_AIRBRUSH_EDGE_EXPONENT_BASE} - hardness * ${TEXTURE_AIRBRUSH_EDGE_HARDNESS_SCALE} + scatter * ${TEXTURE_AIRBRUSH_EDGE_SCATTER_SCALE};
              coverage = min(1.0, pow(edge, exponent));
            }
            float alpha = min(1.0, brushOpacity * strength * coverage);
            if (alpha <= ${TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD}) {
              discard;
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
          depthWrite: false
        });
      }
      this.textureAirbrushGpuCopyMaterial.map = sourceTexture;
      this.textureAirbrushGpuCopyMaterial.needsUpdate = true;
      return this.textureAirbrushGpuCopyMaterial;
    },

    textureAirbrushRenderTextureSettings(sourceTexture) {
      const minFilter = sourceTexture?.minFilter || THREE.LinearFilter;
      const usesMipmaps = MIPMAP_FILTERS.has(minFilter);
      return {
        minFilter,
        magFilter: sourceTexture?.magFilter || THREE.LinearFilter,
        wrapS: sourceTexture?.wrapS || THREE.ClampToEdgeWrapping,
        wrapT: sourceTexture?.wrapT || THREE.ClampToEdgeWrapping,
        generateMipmaps: sourceTexture?.generateMipmaps !== false && usesMipmaps
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
