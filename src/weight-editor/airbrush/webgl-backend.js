import { installTextureAirbrushWebGlMaterialMethods } from "./webgl-materials.js?v=visible-normal-20260624a";
import { installTextureAirbrushWebGlProjectMethods } from "./webgl-project.js?v=visible-normal-20260624a";

const TEXTURE_AIRBRUSH_LAYER_HIT_SEED_MAX_AGE_MS = 10000;

function materialsForAirbrushRecord(record = null) {
  return Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
}

function liveLayerShaderCompileKey(targetEntry = null) {
  const texture = targetEntry?.target?.texture || null;
  return texture?.uuid || texture?.name || "live-layer";
}

function texturePaintLayerEffectivelyEmpty(layer = null) {
  if (!layer) {
    return true;
  }
  if (Math.max(0, Math.floor(Number(layer.gpuTarget?.paintRevision) || 0)) > 0) {
    return false;
  }
  if (layer.isEmpty === true && layer.gpuTarget?.emptyTransparent !== false) {
    return true;
  }
  return layer.gpuTarget?.emptyTransparent === true && layer.isEmpty !== false;
}

function texturePaintLayerOpacity(layer = null) {
  const opacity = Number(layer?.opacity);
  return Number.isFinite(opacity) ? opacity : 1;
}

function texturePaintLayerContributesVisiblePaint(layer = null) {
  return Boolean(
    layer
    && layer.visible !== false
    && texturePaintLayerOpacity(layer) > 0
    && !texturePaintLayerEffectivelyEmpty(layer)
  );
}

function textureAirbrushActiveLayerPaintMode(editor = null) {
  return editor?.activeTool === "airbrush"
    && editor?.texturePaintLayerModeActive?.() === true
    && editor?.texturePaintHasActivePaintLayer?.() === true;
}

function texturePaintLayerTextureIdentity(layer = null) {
  const texture = layer?.gpuTarget?.target?.texture || layer?.gpuLayerTexture || null;
  return texture?.uuid || texture?.name || "";
}

function stableDepthCacheNumber(value = 0, decimals = 7) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Number(0).toFixed(decimals);
  }
  const scale = 10 ** decimals;
  const rounded = Math.round(number * scale) / scale;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(decimals);
}

function texturePaintVisibleLowerLayers(targetEntry = null) {
  const stack = targetEntry?.layerStack || null;
  const layer = targetEntry?.layer || null;
  const layers = stack?.layers || [];
  const layerIndex = layers.indexOf(layer);
  return layerIndex > 0
    ? layers.slice(0, layerIndex).filter((stackLayer) => texturePaintLayerContributesVisiblePaint(stackLayer))
    : [];
}

function scheduledPrewarmOptions(options = {}, force = false) {
  const scheduled = {
    force: force || options.force === true
  };
  if (options.all === true) {
    scheduled.all = true;
  }
  if (Number.isFinite(Number(options.limit))) {
    scheduled.limit = Number(options.limit);
  }
  if (options.immediateLayer === false) {
    scheduled.immediateLayer = false;
  }
  if (options.preserveLayerDisplay === true) {
    scheduled.preserveLayerDisplay = true;
  }
  if (Number.isFinite(Number(options.delay))) {
    scheduled.delay = Number(options.delay);
  }
  return scheduled;
}

function mergeScheduledPrewarmOptions(previous = null, next = {}, force = false) {
  const merged = {
    ...(previous || {}),
    ...scheduledPrewarmOptions(next, force)
  };
  if (previous?.force === true || next?.force === true || force) {
    merged.force = true;
  }
  if (previous?.all === true || next?.all === true) {
    merged.all = true;
  }
  if (previous?.preserveLayerDisplay === true || next?.preserveLayerDisplay === true) {
    merged.preserveLayerDisplay = true;
  }
  if (Number.isFinite(Number(previous?.limit)) && Number.isFinite(Number(next?.limit))) {
    merged.limit = Math.max(Number(previous.limit), Number(next.limit));
  }
  return merged;
}

export function installTextureAirbrushWebGlBackendMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;
  installTextureAirbrushWebGlMaterialMethods(BirdWeightEditor, deps);
  installTextureAirbrushWebGlProjectMethods(BirdWeightEditor, deps);

  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushCopyTextureToTarget(sourceTexture, destinationTarget) {
      if (!this.renderer || !sourceTexture || !destinationTarget) {
        return false;
      }
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        return false;
      }
      this.textureAirbrushCopyTextureRenderSettings?.(destinationTarget.texture, sourceTexture);
      if (sourceTexture.isRenderTargetTexture && typeof this.renderer.copyTextureToTexture === "function") {
        try {
          this.renderer.initRenderTarget?.(destinationTarget);
          this.renderer.copyTextureToTexture(sourceTexture, destinationTarget.texture);
          return true;
        } catch (error) {
          console.warn("Texture airbrush direct render-target copy failed; using shader copy", error);
        }
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousClearAlpha = typeof this.renderer.getClearAlpha === "function"
        ? this.renderer.getClearAlpha()
        : 1;
      const previousClearColor = typeof THREE.Color === "function" ? new THREE.Color() : null;
      if (previousClearColor && typeof this.renderer.getClearColor === "function") {
        this.renderer.getClearColor(previousClearColor);
      }
      try {
        this.textureAirbrushGpuCopyMesh.material = this.textureAirbrushCopyMaterial(sourceTexture);
        this.textureAirbrushWithRawTextureMatrix(sourceTexture, () => {
          this.renderer.setRenderTarget(destinationTarget);
          this.renderer.autoClear = true;
          this.renderer.setClearColor?.(0x000000, 0);
          this.renderer.clear(true, true, true);
          this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
        });
      } finally {
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.autoClear = previousAutoClear;
        if (previousClearColor && typeof this.renderer.setClearColor === "function") {
          this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        }
      }
      return true;
    },

    clearTexturePaintGpuTarget(targetEntry = null, options = {}) {
      const target = targetEntry?.target || targetEntry || null;
      if (!this.renderer || !target) {
        return false;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousClearAlpha = typeof this.renderer.getClearAlpha === "function"
        ? this.renderer.getClearAlpha()
        : 1;
      const previousClearColor = typeof THREE.Color === "function" ? new THREE.Color() : null;
      if (previousClearColor && typeof this.renderer.getClearColor === "function") {
        this.renderer.getClearColor(previousClearColor);
      }
      try {
        this.renderer.setRenderTarget(target);
        this.renderer.autoClear = true;
        this.renderer.setClearColor?.(0x000000, 0);
        this.renderer.clear(true, true, true);
      } finally {
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.autoClear = previousAutoClear;
        if (previousClearColor && typeof this.renderer.setClearColor === "function") {
          this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        }
      }
      if (targetEntry?.target) {
        targetEntry.emptyTransparent = true;
        if (options.markMutated !== false) {
          this.markTexturePaintGpuTargetMutated?.(targetEntry);
        }
      }
      return true;
    },

    textureAirbrushEnsureCurrentTargetSnapshotTarget(targetEntry = null) {
      const sourceTexture = targetEntry?.target?.texture || null;
      if (!this.renderer || !sourceTexture || typeof THREE.WebGLRenderTarget !== "function") {
        return null;
      }
      const width = Math.max(1, Math.round(targetEntry.width || targetEntry.target?.width || 1));
      const height = Math.max(1, Math.round(targetEntry.height || targetEntry.target?.height || 1));
      let snapshot = this.textureAirbrushCurrentTargetSnapshotTarget || null;
      if (!snapshot || snapshot.width !== width || snapshot.height !== height) {
        snapshot?.dispose?.();
        const settings = this.textureAirbrushRenderTextureSettings(sourceTexture);
        snapshot = new THREE.WebGLRenderTarget(width, height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        snapshot.texture.name = "texture airbrush current stroke target";
        this.textureAirbrushCurrentTargetSnapshotTarget = snapshot;
      }
      this.textureAirbrushCopyTextureRenderSettings?.(snapshot.texture, sourceTexture);
      return snapshot;
    },

    textureAirbrushPrewarmCurrentTargetSnapshot(targetEntry = null) {
      return Boolean(this.textureAirbrushEnsureCurrentTargetSnapshotTarget?.(targetEntry));
    },

    textureAirbrushCurrentTargetSnapshot(targetEntry = null) {
      const sourceTexture = targetEntry?.target?.texture || null;
      const snapshot = this.textureAirbrushEnsureCurrentTargetSnapshotTarget?.(targetEntry);
      if (!snapshot || !sourceTexture) {
        return null;
      }
      if (!this.textureAirbrushCopyTextureToTarget(sourceTexture, snapshot)) {
        return null;
      }
      return snapshot;
    },

    textureAirbrushLayerCompositeMaterial(opacity = 1) {
      if (!this.textureAirbrushGpuLayerCompositeMaterial) {
        this.textureAirbrushGpuLayerCompositeMaterial = new THREE.MeshBasicMaterial({
          depthTest: false,
          depthWrite: false,
          transparent: true,
          blending: THREE.NormalBlending
        });
      }
      const material = this.textureAirbrushGpuLayerCompositeMaterial;
      material.opacity = Math.max(0, Math.min(1, Number(opacity) || 0));
      material.transparent = true;
      return material;
    },

    textureAirbrushLayerBlendCompositeMaterial(blendMode = "normal", opacity = 1) {
      if (!this.textureAirbrushGpuLayerBlendCompositeMaterial) {
        this.textureAirbrushGpuLayerBlendCompositeMaterial = new THREE.ShaderMaterial({
          depthTest: false,
          depthWrite: false,
          transparent: false,
          blending: THREE.NoBlending,
          uniforms: {
            baseTexture: { value: null },
            layerTexture: { value: null },
            layerOpacity: { value: 1 },
            blendMode: { value: 0 }
          },
          vertexShader: `
            varying vec2 vUv;

            void main() {
              vUv = uv;
              gl_Position = vec4(position.xy, 0.0, 1.0);
            }
          `,
          fragmentShader: `
            precision highp float;

            uniform sampler2D baseTexture;
            uniform sampler2D layerTexture;
            uniform float layerOpacity;
            uniform int blendMode;
            varying vec2 vUv;

            float blendSoftLightChannel(float base, float source) {
              if (source <= 0.5) {
                return base - (1.0 - 2.0 * source) * base * (1.0 - base);
              }
              float d = base <= 0.25
                ? ((16.0 * base - 12.0) * base + 4.0) * base
                : sqrt(base);
              return base + (2.0 * source - 1.0) * (d - base);
            }

            vec3 blendSoftLight(vec3 base, vec3 source) {
              return vec3(
                blendSoftLightChannel(base.r, source.r),
                blendSoftLightChannel(base.g, source.g),
                blendSoftLightChannel(base.b, source.b)
              );
            }

            float texturePaintBlendLuminance(vec3 color) {
              return dot(color, vec3(0.3, 0.59, 0.11));
            }

            float texturePaintBlendSaturation(vec3 color) {
              return max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
            }

            vec3 clipColor(vec3 color) {
              float l = texturePaintBlendLuminance(color);
              float n = min(min(color.r, color.g), color.b);
              float x = max(max(color.r, color.g), color.b);
              if (n < 0.0) {
                color = l + ((color - l) * l) / (l - n);
              }
              if (x > 1.0) {
                color = l + ((color - l) * (1.0 - l)) / (x - l);
              }
              return clamp(color, 0.0, 1.0);
            }

            vec3 setLuminance(vec3 color, float l) {
              return clipColor(color + (l - texturePaintBlendLuminance(color)));
            }

            vec3 setSaturation(vec3 color, float s) {
              float cMin = min(min(color.r, color.g), color.b);
              float cMax = max(max(color.r, color.g), color.b);
              if (cMax <= cMin) {
                return vec3(0.0);
              }
              return (color - cMin) * s / (cMax - cMin);
            }

            vec3 blendColor(vec3 base, vec3 source, int mode) {
              if (mode == 1) {
                return base * source;
              }
              if (mode == 2) {
                return base + source - base * source;
              }
              if (mode == 3) {
                return mix(2.0 * base * source, 1.0 - 2.0 * (1.0 - base) * (1.0 - source), step(0.5, base));
              }
              if (mode == 4) {
                return min(base, source);
              }
              if (mode == 5) {
                return max(base, source);
              }
              if (mode == 6) {
                vec3 dodge = min(vec3(1.0), base / max(vec3(0.0001), vec3(1.0) - source));
                return mix(dodge, vec3(1.0), step(vec3(0.9999), source));
              }
              if (mode == 7) {
                vec3 burn = 1.0 - min(vec3(1.0), (1.0 - base) / max(vec3(0.0001), source));
                return mix(vec3(0.0), burn, step(vec3(0.0001), source));
              }
              if (mode == 8) {
                return mix(2.0 * base * source, 1.0 - 2.0 * (1.0 - base) * (1.0 - source), step(0.5, source));
              }
              if (mode == 9) {
                return blendSoftLight(base, source);
              }
              if (mode == 10) {
                return abs(base - source);
              }
              if (mode == 11) {
                return base + source - 2.0 * base * source;
              }
              if (mode == 12) {
                return setLuminance(setSaturation(source, texturePaintBlendSaturation(base)), texturePaintBlendLuminance(base));
              }
              if (mode == 13) {
                return setLuminance(setSaturation(base, texturePaintBlendSaturation(source)), texturePaintBlendLuminance(base));
              }
              if (mode == 14) {
                return setLuminance(source, texturePaintBlendLuminance(base));
              }
              if (mode == 15) {
                return setLuminance(base, texturePaintBlendLuminance(source));
              }
              return source;
            }

            void main() {
              vec4 base = texture2D(baseTexture, vUv);
              vec4 layer = texture2D(layerTexture, vUv);
              float alpha = clamp(layer.a * layerOpacity, 0.0, 1.0);
              vec3 blended = blendColor(base.rgb, layer.rgb, blendMode);
              gl_FragColor = vec4(mix(base.rgb, blended, alpha), max(base.a, alpha));
            }
          `
        });
      }
      const material = this.textureAirbrushGpuLayerBlendCompositeMaterial;
      material.uniforms.layerOpacity.value = Math.max(0, Math.min(1, Number(opacity) || 0));
      material.uniforms.blendMode.value = Number(this.texturePaintLayerBlendShaderCode?.(blendMode)) || 0;
      return material;
    },

    texturePaintInstallLiveLayerShaderComposite(material = null) {
      if (!material) {
        return null;
      }
      material.userData ||= {};
      const existing = material.userData.texturePaintLiveLayerShaderComposite || null;
      if (existing) {
        return existing;
      }
      const originalOnBeforeCompile = material.onBeforeCompile;
      const originalCustomProgramCacheKey = material.customProgramCacheKey;
      const state = {
        originalOnBeforeCompile,
        originalCustomProgramCacheKey,
        layerTexture: null,
        layerOpacity: 1,
        layerBlendMode: 0,
        shader: null
      };
      material.onBeforeCompile = function onBeforeCompileTexturePaintLiveLayer(shader, renderer) {
        originalOnBeforeCompile?.call(this, shader, renderer);
        shader.uniforms.texturePaintLiveLayerMap = { value: state.layerTexture || null };
        shader.uniforms.texturePaintLiveLayerOpacity = { value: state.layerOpacity };
        shader.uniforms.texturePaintLiveLayerBlendMode = { value: state.layerBlendMode };
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <map_pars_fragment>",
            `#include <map_pars_fragment>
uniform sampler2D texturePaintLiveLayerMap;
uniform float texturePaintLiveLayerOpacity;
uniform int texturePaintLiveLayerBlendMode;

float texturePaintLiveBlendSoftLightChannel(float base, float source) {
  if (source <= 0.5) {
    return base - (1.0 - 2.0 * source) * base * (1.0 - base);
  }
  float d = base <= 0.25
    ? ((16.0 * base - 12.0) * base + 4.0) * base
    : sqrt(base);
  return base + (2.0 * source - 1.0) * (d - base);
}

vec3 texturePaintLiveBlendSoftLight(vec3 base, vec3 source) {
  return vec3(
    texturePaintLiveBlendSoftLightChannel(base.r, source.r),
    texturePaintLiveBlendSoftLightChannel(base.g, source.g),
    texturePaintLiveBlendSoftLightChannel(base.b, source.b)
  );
}

float texturePaintLiveBlendLuminance(vec3 color) {
  return dot(color, vec3(0.3, 0.59, 0.11));
}

float texturePaintLiveBlendSaturation(vec3 color) {
  return max(max(color.r, color.g), color.b) - min(min(color.r, color.g), color.b);
}

vec3 texturePaintLiveClipColor(vec3 color) {
  float l = texturePaintLiveBlendLuminance(color);
  float n = min(min(color.r, color.g), color.b);
  float x = max(max(color.r, color.g), color.b);
  if (n < 0.0) {
    color = l + ((color - l) * l) / (l - n);
  }
  if (x > 1.0) {
    color = l + ((color - l) * (1.0 - l)) / (x - l);
  }
  return clamp(color, 0.0, 1.0);
}

vec3 texturePaintLiveSetLuminance(vec3 color, float l) {
  return texturePaintLiveClipColor(color + (l - texturePaintLiveBlendLuminance(color)));
}

vec3 texturePaintLiveSetSaturation(vec3 color, float s) {
  float cMin = min(min(color.r, color.g), color.b);
  float cMax = max(max(color.r, color.g), color.b);
  if (cMax <= cMin) {
    return vec3(0.0);
  }
  return (color - cMin) * s / (cMax - cMin);
}

vec3 texturePaintLiveBlendColor(vec3 base, vec3 source, int mode) {
  if (mode == 1) {
    return base * source;
  }
  if (mode == 2) {
    return base + source - base * source;
  }
  if (mode == 3) {
    return mix(2.0 * base * source, 1.0 - 2.0 * (1.0 - base) * (1.0 - source), step(0.5, base));
  }
  if (mode == 4) {
    return min(base, source);
  }
  if (mode == 5) {
    return max(base, source);
  }
  if (mode == 6) {
    vec3 dodge = min(vec3(1.0), base / max(vec3(0.0001), vec3(1.0) - source));
    return mix(dodge, vec3(1.0), step(vec3(0.9999), source));
  }
  if (mode == 7) {
    vec3 burn = 1.0 - min(vec3(1.0), (1.0 - base) / max(vec3(0.0001), source));
    return mix(vec3(0.0), burn, step(vec3(0.0001), source));
  }
  if (mode == 8) {
    return mix(2.0 * base * source, 1.0 - 2.0 * (1.0 - base) * (1.0 - source), step(0.5, source));
  }
  if (mode == 9) {
    return texturePaintLiveBlendSoftLight(base, source);
  }
  if (mode == 10) {
    return abs(base - source);
  }
  if (mode == 11) {
    return base + source - 2.0 * base * source;
  }
  if (mode == 12) {
    return texturePaintLiveSetLuminance(texturePaintLiveSetSaturation(source, texturePaintLiveBlendSaturation(base)), texturePaintLiveBlendLuminance(base));
  }
  if (mode == 13) {
    return texturePaintLiveSetLuminance(texturePaintLiveSetSaturation(base, texturePaintLiveBlendSaturation(source)), texturePaintLiveBlendLuminance(base));
  }
  if (mode == 14) {
    return texturePaintLiveSetLuminance(source, texturePaintLiveBlendLuminance(base));
  }
  if (mode == 15) {
    return texturePaintLiveSetLuminance(base, texturePaintLiveBlendLuminance(source));
  }
  return source;
}`
          )
          .replace(
            "#include <map_fragment>",
            `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
  #endif
  vec4 texturePaintLiveLayerColor = texture2D( texturePaintLiveLayerMap, vMapUv );
  float texturePaintLiveLayerAlpha = clamp(texturePaintLiveLayerColor.a * texturePaintLiveLayerOpacity, 0.0, 1.0);
  vec3 texturePaintLiveBlendedColor = texturePaintLiveBlendColor(
    sampledDiffuseColor.rgb,
    texturePaintLiveLayerColor.rgb,
    texturePaintLiveLayerBlendMode
  );
  sampledDiffuseColor.rgb = mix(
    sampledDiffuseColor.rgb,
    texturePaintLiveBlendedColor,
    texturePaintLiveLayerAlpha
  );
  sampledDiffuseColor.a = max(sampledDiffuseColor.a, texturePaintLiveLayerAlpha);
  diffuseColor *= sampledDiffuseColor;
#endif`
          );
        state.shader = shader;
      };
      material.customProgramCacheKey = function texturePaintLiveLayerShaderCacheKey() {
        const baseKey = typeof originalCustomProgramCacheKey === "function"
          ? originalCustomProgramCacheKey.call(this)
          : "";
        return `${baseKey}|texture-paint-live-layer-v3`;
      };
      material.userData.texturePaintLiveLayerShaderComposite = state;
      material.needsUpdate = true;
      return state;
    },

    texturePaintDisableLiveLayerShaderComposite(material = null) {
      const state = material?.userData?.texturePaintLiveLayerShaderComposite || null;
      if (!material || !state) {
        return false;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerMap) {
        state.shader.uniforms.texturePaintLiveLayerMap.value = null;
      }
      material.onBeforeCompile = state.originalOnBeforeCompile;
      material.customProgramCacheKey = state.originalCustomProgramCacheKey;
      delete material.userData.texturePaintLiveLayerShaderComposite;
      this.texturePaintDisposeLiveLayerUnderlay?.(material);
      material.needsUpdate = true;
      return true;
    },

    texturePaintMuteLiveLayerShaderComposite(material = null) {
      const state = material?.userData?.texturePaintLiveLayerShaderComposite || null;
      if (!material || !state) {
        return false;
      }
      state.layerOpacity = 0;
      if (state.shader?.uniforms?.texturePaintLiveLayerOpacity) {
        state.shader.uniforms.texturePaintLiveLayerOpacity.value = 0;
      }
      return true;
    },

    texturePaintUseLiveLayerShaderComposite(material = null, targetEntry = null, baseTexture = null, options = {}) {
      const layerTexture = targetEntry?.target?.texture || null;
      if (!material || !baseTexture || !layerTexture) {
        return null;
      }
      const state = this.texturePaintInstallLiveLayerShaderComposite?.(material);
      if (!state) {
        return null;
      }
      const layerOpacity = texturePaintLayerOpacity(targetEntry.layer);
      const layerBlendMode = this.texturePaintLayerBlendMode?.(targetEntry.layer) || "normal";
      const layerBlendCode = Number(this.texturePaintLayerBlendShaderCode?.(layerBlendMode)) || 0;
      state.layerTexture = layerTexture;
      state.layerOpacity = layerOpacity;
      state.layerBlendMode = layerBlendCode;
      let updatedUniform = false;
      if (state.shader?.uniforms?.texturePaintLiveLayerMap) {
        state.shader.uniforms.texturePaintLiveLayerMap.value = layerTexture;
        updatedUniform = true;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerOpacity) {
        state.shader.uniforms.texturePaintLiveLayerOpacity.value = layerOpacity;
        updatedUniform = true;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerBlendMode) {
        state.shader.uniforms.texturePaintLiveLayerBlendMode.value = layerBlendCode;
        updatedUniform = true;
      }
      if (!updatedUniform) {
        material.needsUpdate = true;
      }
      if (material.map !== baseTexture) {
        material.map = baseTexture;
        material.needsUpdate = true;
      }
      targetEntry.liveShaderComposite = true;
      this.texturePaintPrecompileLiveLayerShaderComposite?.(material, targetEntry);
      const compositeTarget = {
        target: targetEntry.target,
        shaderComposite: true
      };
      targetEntry.liveCompositeTarget = compositeTarget;
      targetEntry.liveCompositeBaseTexture = baseTexture;
      targetEntry.liveCompositeLayer = targetEntry.layer || null;
      const stackLayers = targetEntry.layerStack?.layers || [];
      targetEntry.liveCompositeLayerCount = stackLayers.length;
      targetEntry.liveCompositeLayerIndex = stackLayers.indexOf(targetEntry.layer);
      targetEntry.liveCompositeLayerOpacity = layerOpacity;
      targetEntry.liveCompositeLayerBlendMode = layerBlendMode;
      targetEntry.liveCompositeUnderlayKey = options.underlayKey || "";
      targetEntry.liveCompositeLayerMutationSerial = this.texturePaintLayerMutationSerialValue?.() ?? 0;
      return compositeTarget;
    },

    texturePaintLayerShouldUseLiveBakedDisplay(material = null, targetEntry = null) {
      if (!this.texturePaintLayerCanUseLiveShaderComposite?.(material, targetEntry)) {
        return false;
      }
      return texturePaintVisibleLowerLayers(targetEntry).length > 0;
    },

    texturePaintLiveBakedDisplayTargetForLayerGpuPaint(material = null, targetEntry = null, liveComposite = null) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.target?.texture) {
        return null;
      }
      if (!this.texturePaintLayerShouldUseLiveBakedDisplay?.(material, targetEntry)) {
        return null;
      }
      const underlayTexture = targetEntry.liveCompositeBaseTexture || liveComposite?.underlayTexture || null;
      if (!underlayTexture || typeof THREE.WebGLRenderTarget !== "function") {
        return null;
      }
      const width = Math.max(1, Math.floor(Number(targetEntry.width || targetEntry.target?.width || targetEntry.layerStack?.width) || 0));
      const height = Math.max(1, Math.floor(Number(targetEntry.height || targetEntry.target?.height || targetEntry.layerStack?.height) || 0));
      if (!width || !height) {
        return null;
      }
      let composite = material.userData.texturePaintCompositeGpuTarget || null;
      if (!composite?.target?.texture || composite.width !== width || composite.height !== height) {
        composite?.target?.dispose?.();
        composite?.scratchTarget?.dispose?.();
        composite?.stagingTarget?.dispose?.();
        const settings = this.textureAirbrushRenderTextureSettings(underlayTexture);
        const target = new THREE.WebGLRenderTarget(width, height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        target.texture.name = `${material.name || "material"} live baked layer display`;
        this.textureAirbrushCopyTextureRenderSettings(target.texture, underlayTexture);
        composite = {
          target,
          scratchTarget: null,
          stagingTarget: null,
          width,
          height
        };
        material.userData.texturePaintCompositeGpuTarget = composite;
      }
      this.textureAirbrushCopyTextureRenderSettings?.(composite.target.texture, underlayTexture);
      return {
        target: composite.target,
        underlayTexture,
        activeTargetEntry: targetEntry,
        activeLayerOpacity: Math.max(0, Math.min(1, texturePaintLayerOpacity(targetEntry.layer))),
        liveBakedDisplayComposite: true
      };
    },

    texturePaintRefreshLiveBakedCompositeForLayerGpuPaint(material = null, targetEntry = null, liveComposite = null) {
      const display = this.texturePaintLiveBakedDisplayTargetForLayerGpuPaint?.(material, targetEntry, liveComposite);
      const underlayTexture = display?.underlayTexture || null;
      const layerTexture = targetEntry?.target?.texture || null;
      const displayTarget = display?.target || null;
      if (!displayTarget?.texture || !underlayTexture || !layerTexture || !this.renderer) {
        return false;
      }
      if (!this.textureAirbrushCopyTextureToTarget?.(underlayTexture, displayTarget)) {
        return false;
      }
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        return false;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const opacity = Math.max(0, Math.min(1, Number(display.activeLayerOpacity) || 0));
      const blendMode = this.texturePaintLayerBlendMode?.(targetEntry.layer) || "normal";
      try {
        this.renderer.setRenderTarget(displayTarget);
        this.renderer.autoClear = false;
        if (blendMode === "normal") {
          const copyMaterial = this.textureAirbrushLayerCompositeMaterial(opacity);
          copyMaterial.map = layerTexture;
          copyMaterial.needsUpdate = true;
          this.textureAirbrushGpuCopyMesh.material = copyMaterial;
          this.textureAirbrushWithRawTextureMatrix(layerTexture, () => {
            this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
          });
        } else {
          const blendMaterial = this.textureAirbrushLayerBlendCompositeMaterial(blendMode, opacity);
          blendMaterial.uniforms.baseTexture.value = underlayTexture;
          blendMaterial.uniforms.layerTexture.value = layerTexture;
          this.textureAirbrushGpuCopyMesh.material = blendMaterial;
          this.textureAirbrushWithRawTextureMatrix(underlayTexture, () => {
            this.textureAirbrushWithRawTextureMatrix(layerTexture, () => {
              this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
            });
          });
        }
      } finally {
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.autoClear = previousAutoClear;
      }
      this.texturePaintMuteLiveLayerShaderComposite?.(material);
      if (material.map !== displayTarget.texture) {
        material.map = displayTarget.texture;
        material.needsUpdate = true;
      }
      return true;
    },

    texturePaintFastCachedLiveLayerShaderComposite(material = null, targetEntry = null) {
      const cached = targetEntry?.liveCompositeTarget || null;
      const layerTexture = targetEntry?.target?.texture || null;
      const state = material?.userData?.texturePaintLiveLayerShaderComposite || null;
      const stack = targetEntry?.layerStack || material?.userData?.texturePaintLayerStack || null;
      const layer = targetEntry?.layer || null;
      const layers = stack?.layers || [];
      const currentMutationSerial = this.texturePaintLayerMutationSerialValue?.() ?? 0;
      const layerOpacity = texturePaintLayerOpacity(layer);
      const layerBlendMode = this.texturePaintLayerBlendMode?.(layer) || "normal";
      const layerBlendCode = Number(this.texturePaintLayerBlendShaderCode?.(layerBlendMode)) || 0;
      if (
        !cached?.target
        || cached.target !== targetEntry?.target
        || cached.shaderComposite !== true
        || !state
        || !layerTexture
        || material.userData?.texturePaintLiveLayerShaderCompileKey !== liveLayerShaderCompileKey(targetEntry)
        || (
          targetEntry.liveCompositeBaseTexture !== material.map
          && material.userData?.texturePaintCompositeGpuTarget?.target?.texture !== material.map
        )
        || targetEntry.liveCompositeLayer !== layer
        || targetEntry.liveCompositeLayerCount !== 1
        || layers.length !== 1
        || layers[0] !== layer
        || targetEntry.liveCompositeLayerIndex !== 0
        || (targetEntry.liveCompositeLayerBlendMode || "normal") !== layerBlendMode
        || targetEntry.liveCompositeLayerMutationSerial !== currentMutationSerial
        || layer?.visible === false
      ) {
        return null;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerMap) {
        state.shader.uniforms.texturePaintLiveLayerMap.value = layerTexture;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerOpacity) {
        state.shader.uniforms.texturePaintLiveLayerOpacity.value = layerOpacity;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerBlendMode) {
        state.shader.uniforms.texturePaintLiveLayerBlendMode.value = layerBlendCode;
      }
      state.layerOpacity = layerOpacity;
      state.layerBlendMode = layerBlendCode;
      targetEntry.liveCompositeLayerOpacity = layerOpacity;
      targetEntry.liveCompositeLayerBlendMode = layerBlendMode;
      return cached;
    },

    texturePaintCachedLiveLayerShaderComposite(material = null, targetEntry = null) {
      const fastCached = this.texturePaintFastCachedLiveLayerShaderComposite?.(material, targetEntry);
      if (fastCached) {
        return fastCached;
      }
      const cached = targetEntry?.liveCompositeTarget || null;
      const layerTexture = targetEntry?.target?.texture || null;
      const state = material?.userData?.texturePaintLiveLayerShaderComposite || null;
      const stack = targetEntry?.layerStack || material?.userData?.texturePaintLayerStack || null;
      const layer = targetEntry?.layer || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(layer);
      const underlayKey = this.texturePaintLiveLayerUnderlayKey?.(targetEntry) || "";
      const layerOpacity = texturePaintLayerOpacity(layer);
      const layerBlendMode = this.texturePaintLayerBlendMode?.(layer) || "normal";
      const layerBlendCode = Number(this.texturePaintLayerBlendShaderCode?.(layerBlendMode)) || 0;
      const lowerLayers = layerIndex >= 0
        ? layers.slice(0, layerIndex).filter((stackLayer) => texturePaintLayerContributesVisiblePaint(stackLayer))
        : [];
      const needsUnderlayTarget = lowerLayers.length > 0;
      const underlay = material?.userData?.texturePaintLiveLayerUnderlayGpuTarget || null;
      if (
        !cached?.target
        || cached.target !== targetEntry?.target
        || cached.shaderComposite !== true
        || !state
        || !layerTexture
        || material.userData?.texturePaintLiveLayerShaderCompileKey !== liveLayerShaderCompileKey(targetEntry)
        || (
          targetEntry.liveCompositeBaseTexture !== material.map
          && material.userData?.texturePaintCompositeGpuTarget?.target?.texture !== material.map
        )
        || targetEntry.liveCompositeLayer !== layer
        || targetEntry.liveCompositeLayerCount !== layers.length
        || targetEntry.liveCompositeLayerIndex !== layerIndex
        || (targetEntry.liveCompositeLayerBlendMode || "normal") !== layerBlendMode
        || targetEntry.liveCompositeUnderlayKey !== underlayKey
        || (needsUnderlayTarget && (
          !underlay?.target?.texture
          || underlay.key !== underlayKey
          || underlay.width !== stack?.width
          || underlay.height !== stack?.height
          || targetEntry.liveCompositeBaseTexture !== underlay.target.texture
        ))
        || layerIndex < 0
        || layer?.visible === false
      ) {
        return null;
      }
      for (let index = layerIndex + 1; index < layers.length; index += 1) {
        if (texturePaintLayerContributesVisiblePaint(layers[index])) {
          return null;
        }
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerMap) {
        state.shader.uniforms.texturePaintLiveLayerMap.value = layerTexture;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerOpacity) {
        state.shader.uniforms.texturePaintLiveLayerOpacity.value = layerOpacity;
      }
      if (state.shader?.uniforms?.texturePaintLiveLayerBlendMode) {
        state.shader.uniforms.texturePaintLiveLayerBlendMode.value = layerBlendCode;
      }
      state.layerOpacity = layerOpacity;
      state.layerBlendMode = layerBlendCode;
      targetEntry.liveCompositeLayerOpacity = layerOpacity;
      targetEntry.liveCompositeLayerBlendMode = layerBlendMode;
      return cached;
    },

    texturePaintCachedLiveCompositeTargetForLayerGpuPaint(material = null, targetEntry = null) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.target?.texture) {
        return null;
      }
      if (this.texturePaintMaterialRequiresExactLayerDisplay?.(material)) {
        return null;
      }
      const fastCached = this.texturePaintFastCachedLiveLayerShaderComposite?.(material, targetEntry);
      if (fastCached) {
        return fastCached;
      }
      const stack = targetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const layer = targetEntry.layer || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(layer);
      if (layerIndex < 0 || layer?.visible === false) {
        return null;
      }
      for (let index = layerIndex + 1; index < layers.length; index += 1) {
        if (texturePaintLayerContributesVisiblePaint(layers[index])) {
          return null;
        }
      }
      return this.texturePaintCachedLiveLayerShaderComposite?.(material, targetEntry) || null;
    },

    texturePaintLayerCanUseLiveShaderComposite(material = null, targetEntry = null) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.target?.texture) {
        return false;
      }
      if (this.texturePaintMaterialRequiresExactLayerDisplay?.(material)) {
        return false;
      }
      const stack = targetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const layer = targetEntry.layer || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(layer);
      if (
        layerIndex < 0
        || layer?.visible === false
        || !stack?.baseCanvas
      ) {
        return false;
      }
      for (let index = layerIndex + 1; index < layers.length; index += 1) {
        if (texturePaintLayerContributesVisiblePaint(layers[index])) {
          return false;
        }
      }
      return true;
    },

    texturePaintLiveUnderlayTargetForLayerGpuPaint(material = null, targetEntry = null, options = {}) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.target?.texture) {
        return null;
      }
      if (this.texturePaintMaterialRequiresExactLayerDisplay?.(material)) {
        return null;
      }
      const stack = targetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const activeLayer = targetEntry.layer || null;
      const layers = stack?.layers || [];
      const activeIndex = layers.indexOf(activeLayer);
      if (
        activeIndex < 0
        || activeLayer?.visible === false
      ) {
        return null;
      }
      const activeLayerOpacity = Math.max(0, Math.min(1, texturePaintLayerOpacity(activeLayer)));
      const visibleLayersAbove = layers
        .slice(activeIndex + 1)
        .filter((layer) => texturePaintLayerContributesVisiblePaint(layer));
      if (visibleLayersAbove.length !== 1) {
        return null;
      }
      const displayLayer = visibleLayersAbove[0];
      if ((this.texturePaintLayerBlendMode?.(displayLayer) || "normal") !== "normal") {
        return null;
      }
      const displayTargetEntry = displayLayer?.gpuTarget || null;
      if (!displayTargetEntry?.target?.texture) {
        return null;
      }
      displayTargetEntry.material = material;
      displayTargetEntry.layer = displayLayer;
      displayTargetEntry.layerStack = stack;
      displayTargetEntry.layerMode = true;
      displayTargetEntry.emptyTransparent = texturePaintLayerEffectivelyEmpty(displayLayer);
      let displayComposite = null;
      try {
        displayComposite = options.cachedOnly === true
          ? this.texturePaintCachedLiveCompositeTargetForLayerGpuPaint?.(material, displayTargetEntry)
          : this.texturePaintLiveCompositeTargetForLayerGpuPaint?.(material, displayTargetEntry);
      } catch {
        return null;
      }
      let underlay = material.userData.texturePaintLiveLayerUnderlayGpuTarget || null;
      if (!underlay?.target?.texture && displayComposite?.shaderComposite) {
        underlay = this.texturePaintEnsureLiveLayerUnderlayPatchTarget?.(material, displayTargetEntry) || null;
      }
      if (!displayComposite?.shaderComposite || !underlay?.target?.texture) {
        return null;
      }
      return {
        target: underlay.target,
        shaderComposite: true,
        underlayComposite: true,
        activeTargetEntry: targetEntry,
        displayTargetEntry,
        activeLayerOpacity,
        refreshUnderlayAfterPaint: false,
        skipLiveBrushRender: false
      };
    },

    texturePaintRefreshLiveUnderlayPatchForLayerGpuPaint(material = null, targetEntry = null, patchTarget = null) {
      const displayTargetEntry = patchTarget?.displayTargetEntry || null;
      const underlay = material?.userData?.texturePaintLiveLayerUnderlayGpuTarget || null;
      if (
        !material?.userData
        || !targetEntry?.layerMode
        || !displayTargetEntry?.target?.texture
        || !underlay?.target
        || patchTarget?.target !== underlay.target
      ) {
        return false;
      }
      const stack = displayTargetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(displayTargetEntry.layer);
      if (layerIndex < 0) {
        return false;
      }
      let underlayKey = this.texturePaintLiveLayerUnderlayKey?.(displayTargetEntry) || "";
      if (patchTarget.refreshUnderlayAfterPaint === true) {
        const baseTexture = underlay.baseTexture
          || material.userData.clonePaintTexture
          || material.userData.clonePaintOriginalMap
          || null;
        const refreshed = this.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint?.(
          material,
          displayTargetEntry,
          baseTexture
        );
        if (!refreshed?.texture) {
          return false;
        }
        underlayKey = refreshed.key || underlayKey;
        displayTargetEntry.liveCompositeBaseTexture = refreshed.texture;
      }
      underlay.key = underlayKey;
      displayTargetEntry.liveCompositeUnderlayKey = underlayKey;
      displayTargetEntry.liveCompositeLayerCount = layers.length;
      displayTargetEntry.liveCompositeLayerIndex = layerIndex;
      displayTargetEntry.liveCompositeLayerMutationSerial = this.texturePaintLayerMutationSerialValue?.() ?? 0;
      return true;
    },

    queueTexturePaintLiveUnderlayRefresh(material = null, displayTargetEntry = null) {
      const underlay = material?.userData?.texturePaintLiveLayerUnderlayGpuTarget || null;
      if (!material?.userData || !displayTargetEntry?.layerMode || !underlay?.target) {
        return false;
      }
      this.pendingTexturePaintLiveUnderlayRefreshes ||= new Map();
      this.pendingTexturePaintLiveUnderlayRefreshes.set(material, displayTargetEntry);
      if (this.texturePaintLiveUnderlayRefreshTimer) {
        return true;
      }
      const host = typeof window !== "undefined" ? window : globalThis;
      const schedule = typeof host?.setTimeout === "function" ? host.setTimeout.bind(host) : null;
      if (!schedule) {
        return false;
      }
      const run = () => {
        this.texturePaintLiveUnderlayRefreshTimer = null;
        if (this.painting || this.textureAirbrushFlushingScreenStroke) {
          this.texturePaintLiveUnderlayRefreshTimer = schedule(run, 80);
          return;
        }
        const pending = this.pendingTexturePaintLiveUnderlayRefreshes || new Map();
        this.pendingTexturePaintLiveUnderlayRefreshes = new Map();
        for (const [candidateMaterial, candidateDisplayTarget] of pending.entries()) {
          const candidateUnderlay = candidateMaterial?.userData?.texturePaintLiveLayerUnderlayGpuTarget || null;
          if (!candidateUnderlay?.target) {
            continue;
          }
          this.texturePaintRefreshLiveUnderlayPatchForLayerGpuPaint?.(
            candidateMaterial,
            candidateDisplayTarget,
            {
              target: candidateUnderlay.target,
              displayTargetEntry: candidateDisplayTarget,
              refreshUnderlayAfterPaint: true
            }
          );
        }
      };
      this.texturePaintLiveUnderlayRefreshTimer = schedule(run, 120);
      return true;
    },

    texturePaintPrecompileLiveLayerShaderComposite(material = null, targetEntry = null) {
      if (!material || !targetEntry?.target?.texture || !this.renderer || !this.scene || !this.camera) {
        return false;
      }
      const compileKey = liveLayerShaderCompileKey(targetEntry);
      if (material.userData?.texturePaintLiveLayerShaderCompileKey === compileKey) {
        return false;
      }
      material.userData ||= {};
      try {
        this.renderer.compile?.(this.scene, this.camera);
        material.userData.texturePaintLiveLayerShaderCompileKey = compileKey;
        const compileAsync = this.renderer.compileAsync?.(this.scene, this.camera);
        if (compileAsync && typeof compileAsync.catch === "function") {
          compileAsync.catch(() => {});
        }
        return true;
      } catch (error) {
        delete material.userData.texturePaintLiveLayerShaderCompileKey;
        return false;
      }
    },

    texturePaintDisposeLiveLayerUnderlay(material = null) {
      const userData = material?.userData || null;
      const underlay = userData?.texturePaintLiveLayerUnderlayGpuTarget || null;
      if (!userData || !underlay) {
        return false;
      }
      underlay.target?.dispose?.();
      underlay.scratchTarget?.dispose?.();
      underlay.stagingTarget?.dispose?.();
      delete userData.texturePaintLiveLayerUnderlayGpuTarget;
      return true;
    },

    texturePaintEnsureLiveLayerUnderlayPatchTarget(material = null, targetEntry = null) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.layerStack?.baseCanvas) {
        return null;
      }
      const stack = targetEntry.layerStack;
      const sourceTexture = material.userData.clonePaintTexture
        || material.userData.clonePaintOriginalMap
        || material.map
        || null;
      const baseTexture = this.textureAirbrushCanvasTextureForLayerCanvas?.(
        stack,
        "base",
        stack.baseCanvas,
        sourceTexture
      );
      if (!baseTexture || !this.renderer || typeof THREE.WebGLRenderTarget !== "function") {
        return null;
      }
      const refreshed = this.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint?.(
        material,
        targetEntry,
        baseTexture,
        { forceTarget: true }
      );
      const underlay = material.userData.texturePaintLiveLayerUnderlayGpuTarget || null;
      if (!refreshed?.texture || !underlay?.target?.texture) {
        return null;
      }
      underlay.baseTexture = baseTexture;
      underlay.key = refreshed.key || this.texturePaintLiveLayerUnderlayKey?.(targetEntry) || "";
      this.texturePaintUseLiveLayerShaderComposite?.(material, targetEntry, refreshed.texture, {
        underlayKey: underlay.key
      });
      return underlay;
    },

    texturePaintLiveLayerUnderlayKey(targetEntry = null) {
      const stack = targetEntry?.layerStack || null;
      const layer = targetEntry?.layer || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(layer);
      if (layerIndex < 0) {
        return "";
      }
      const parts = [
        "live-underlay-v1",
        this.texturePaintLayerMutationSerialValue?.() ?? 0,
        stack.width || 0,
        stack.height || 0,
        layerIndex
      ];
      for (let index = 0; index < layerIndex; index += 1) {
        const stackLayer = layers[index];
        parts.push(
          stackLayer?.id || String(index),
          stackLayer?.visible === false ? "0" : "1",
          Number(texturePaintLayerOpacity(stackLayer)).toFixed(4),
          this.texturePaintLayerBlendMode?.(stackLayer) || "normal",
          texturePaintLayerEffectivelyEmpty(stackLayer) ? "empty" : "painted",
          texturePaintLayerTextureIdentity(stackLayer),
          this.texturePaintGpuTargetRevision?.(stackLayer?.gpuTarget) ?? Math.max(
            0,
            Math.floor(Number(stackLayer?.gpuTarget?.paintRevision) || 0)
          )
        );
      }
      return parts.join("|");
    },

    texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint(material = null, targetEntry = null, baseTexture = null, options = {}) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.target?.texture || !baseTexture) {
        return null;
      }
      const stack = targetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const layer = targetEntry.layer || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(layer);
      if (layerIndex < 0) {
        return null;
      }
      const underlayKey = this.texturePaintLiveLayerUnderlayKey?.(targetEntry) || "";
      const lowerLayers = layers
        .slice(0, layerIndex)
        .filter((stackLayer) => texturePaintLayerContributesVisiblePaint(stackLayer));
      if (!lowerLayers.length && options.forceTarget !== true) {
        return {
          texture: baseTexture,
          key: underlayKey
        };
      }
      let underlay = material.userData.texturePaintLiveLayerUnderlayGpuTarget || null;
      const canReuseUnderlayTarget = Boolean(
        underlay?.target?.texture
        && underlay.width === stack.width
        && underlay.height === stack.height
      );
      if (canReuseUnderlayTarget && underlay.key === underlayKey && underlay.baseTexture === baseTexture) {
        return {
          texture: underlay.target.texture,
          key: underlayKey
        };
      }
      if (!this.renderer || typeof THREE.WebGLRenderTarget !== "function") {
        delete material.userData.texturePaintLiveLayerUnderlayGpuTarget;
        return null;
      }
      let target = underlay?.target || null;
      let scratchTarget = underlay?.scratchTarget || null;
      let stagingTarget = underlay?.stagingTarget || null;
      if (!canReuseUnderlayTarget) {
        underlay?.target?.dispose?.();
        underlay?.scratchTarget?.dispose?.();
        underlay?.stagingTarget?.dispose?.();
        scratchTarget = null;
        stagingTarget = null;
        const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
        target = new THREE.WebGLRenderTarget(stack.width, stack.height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        target.texture.name = `${material.name || "material"} live layer underlay`;
      }
      this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);
      const ensureScratchTarget = () => {
        if (scratchTarget?.texture) {
          this.textureAirbrushCopyTextureRenderSettings(scratchTarget.texture, baseTexture);
          return scratchTarget;
        }
        const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
        scratchTarget = new THREE.WebGLRenderTarget(stack.width, stack.height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        scratchTarget.texture.name = `${material.name || "material"} live layer blend underlay`;
        this.textureAirbrushCopyTextureRenderSettings(scratchTarget.texture, baseTexture);
        return scratchTarget;
      };
      const ensureStagingTarget = () => {
        if (stagingTarget?.texture) {
          this.textureAirbrushCopyTextureRenderSettings(stagingTarget.texture, baseTexture);
          return stagingTarget;
        }
        const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
        stagingTarget = new THREE.WebGLRenderTarget(stack.width, stack.height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        stagingTarget.texture.name = `${material.name || "material"} live layer staging underlay`;
        this.textureAirbrushCopyTextureRenderSettings(stagingTarget.texture, baseTexture);
        return stagingTarget;
      };
      const displayedTexture = material.map || null;
      const displayedTarget = [target, scratchTarget, stagingTarget]
        .find((candidate) => candidate?.texture && candidate.texture === displayedTexture)
        || null;
      const inactiveTargetFor = (currentTarget = null) => {
        const candidates = [target, scratchTarget].filter((candidate) => (
          candidate?.texture
          && candidate !== currentTarget
          && candidate !== displayedTarget
        ));
        if (candidates.length) {
          return candidates[0];
        }
        const staging = ensureStagingTarget();
        if (staging !== currentTarget && staging !== displayedTarget) {
          return staging;
        }
        return currentTarget === target ? ensureScratchTarget() : target;
      };
      const promoteUnderlayTarget = (finishedTarget = target) => {
        if (!finishedTarget || finishedTarget === target) {
          return;
        }
        const previousTarget = target;
        target = finishedTarget;
        if (scratchTarget === finishedTarget) {
          scratchTarget = previousTarget;
        } else if (stagingTarget === finishedTarget) {
          stagingTarget = previousTarget;
        } else if (!scratchTarget || scratchTarget === target) {
          scratchTarget = previousTarget;
        }
      };
      if (!lowerLayers.length && options.forceTarget === true && typeof this.textureAirbrushCopyTextureToTarget === "function") {
        const copyTarget = displayedTarget === target ? ensureScratchTarget() : target;
        if (!this.textureAirbrushCopyTextureToTarget(baseTexture, copyTarget)) {
          return null;
        }
        promoteUnderlayTarget(copyTarget);
        underlay = {
          target,
          scratchTarget,
          stagingTarget,
          width: stack.width,
          height: stack.height,
          key: underlayKey,
          baseTexture
        };
        material.userData.texturePaintLiveLayerUnderlayGpuTarget = underlay;
        return {
          texture: target.texture,
          key: underlayKey
        };
      }
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        delete material.userData.texturePaintLiveLayerUnderlayGpuTarget;
        return null;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousClearAlpha = typeof this.renderer.getClearAlpha === "function"
        ? this.renderer.getClearAlpha()
        : 1;
      const previousClearColor = typeof THREE.Color === "function" ? new THREE.Color() : null;
      if (previousClearColor && typeof this.renderer.getClearColor === "function") {
        this.renderer.getClearColor(previousClearColor);
      }
      const sourceTexture = material.userData.clonePaintTexture
        || material.userData.clonePaintOriginalMap
        || baseTexture;
      const renderTexture = (texture, opacity = 1, destination = target) => {
        if (!texture || !destination) {
          return;
        }
        const copyMaterial = this.textureAirbrushLayerCompositeMaterial(opacity);
        copyMaterial.map = texture;
        copyMaterial.needsUpdate = true;
        this.textureAirbrushGpuCopyMesh.material = copyMaterial;
        this.renderer.setRenderTarget(destination);
        this.textureAirbrushWithRawTextureMatrix(texture, () => {
          this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
        });
      };
      const blendTexture = (base, texture, opacity, blendMode, destination) => {
        if (!base || !texture || !destination) {
          return false;
        }
        const blendMaterial = this.textureAirbrushLayerBlendCompositeMaterial(blendMode, opacity);
        blendMaterial.uniforms.baseTexture.value = base;
        blendMaterial.uniforms.layerTexture.value = texture;
        this.textureAirbrushGpuCopyMesh.material = blendMaterial;
        this.renderer.setRenderTarget(destination);
        this.textureAirbrushWithRawTextureMatrix(base, () => {
          this.textureAirbrushWithRawTextureMatrix(texture, () => {
            this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
          });
        });
        return true;
      };
      try {
        let currentTarget = displayedTarget === target ? ensureScratchTarget() : target;
        this.renderer.setRenderTarget(currentTarget);
        this.renderer.autoClear = false;
        this.renderer.setClearColor?.(0x000000, 0);
        this.renderer.clear?.(true, true, true);
        renderTexture(baseTexture, 1, currentTarget);
        for (const lowerLayer of lowerLayers) {
          const texture = lowerLayer.gpuTarget?.target?.texture
            || this.textureAirbrushCanvasTextureForLayerCanvas(lowerLayer, "gpuLayer", lowerLayer.canvas, sourceTexture);
          const blendMode = this.texturePaintLayerBlendMode?.(lowerLayer) || "normal";
          if (blendMode === "normal") {
            renderTexture(texture, lowerLayer.opacity ?? 1, currentTarget);
            continue;
          }
          const nextTarget = inactiveTargetFor(currentTarget);
          if (blendTexture(currentTarget.texture, texture, lowerLayer.opacity ?? 1, blendMode, nextTarget)) {
            currentTarget = nextTarget;
          }
        }
        promoteUnderlayTarget(currentTarget);
      } finally {
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.autoClear = previousAutoClear;
        if (previousClearColor && typeof this.renderer.setClearColor === "function") {
          this.renderer.setClearColor(previousClearColor, previousClearAlpha);
        }
      }
      underlay = {
        target,
        scratchTarget,
        stagingTarget,
        width: stack.width,
        height: stack.height,
        key: underlayKey,
        baseTexture
      };
      material.userData.texturePaintLiveLayerUnderlayGpuTarget = underlay;
      return {
        texture: target.texture,
        key: underlayKey
      };
    },

    texturePaintLiveLayerShaderCompositeForLayerGpuPaint(material = null, targetEntry = null) {
      if (!this.texturePaintLayerCanUseLiveShaderComposite?.(material, targetEntry)) {
        return null;
      }
      const stack = targetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const sourceTexture = material.userData.clonePaintTexture
        || material.userData.clonePaintOriginalMap
        || targetEntry.sourceTexture
        || material.map
        || null;
      const baseTexture = this.textureAirbrushCanvasTextureForLayerCanvas(stack, "base", stack.baseCanvas, sourceTexture);
      if (!baseTexture) {
        return null;
      }
      const underlay = this.texturePaintLiveLayerUnderlayBaseTextureForLayerGpuPaint?.(material, targetEntry, baseTexture);
      if (!underlay?.texture) {
        return null;
      }
      return this.texturePaintUseLiveLayerShaderComposite?.(material, targetEntry, underlay.texture, {
        underlayKey: underlay.key
      });
    },

    textureAirbrushCanvasTextureForLayerCanvas(owner = null, key = "texture", canvas = null, sourceTexture = null) {
      if (!owner || !canvas) {
        return null;
      }
      const textureKey = `${key}Texture`;
      let texture = owner[textureKey] || null;
      if (!texture || texture.image !== canvas) {
        texture?.dispose?.();
        texture = new THREE.CanvasTexture(canvas);
        owner[textureKey] = texture;
      }
      texture.name = owner.name ? `${owner.name} ${key}` : `texture paint ${key}`;
      if (sourceTexture && typeof this.textureAirbrushCopyTextureRenderSettings === "function") {
        this.textureAirbrushCopyTextureRenderSettings(texture, sourceTexture);
      } else {
        texture.colorSpace = sourceTexture?.colorSpace || THREE.SRGBColorSpace;
        texture.flipY = sourceTexture?.flipY ?? false;
        texture.wrapS = sourceTexture?.wrapS || THREE.ClampToEdgeWrapping;
        texture.wrapT = sourceTexture?.wrapT || THREE.ClampToEdgeWrapping;
        texture.magFilter = sourceTexture?.magFilter || THREE.LinearFilter;
        texture.minFilter = sourceTexture?.minFilter || THREE.LinearFilter;
        texture.generateMipmaps = sourceTexture?.generateMipmaps ?? true;
        texture.needsUpdate = true;
      }
      return texture;
    },

    textureAirbrushRenderTargetSizeForTexture(texture) {
      const image = texture?.image;
      const width = image?.naturalWidth || image?.videoWidth || image?.displayWidth || image?.width || 0;
      const height = image?.naturalHeight || image?.videoHeight || image?.displayHeight || image?.height || 0;
      return {
        width: Math.max(1, Math.min(4096, Math.round(width || 1024))),
        height: Math.max(1, Math.min(4096, Math.round(height || 1024)))
      };
    },

    textureAirbrushGpuUvBleedOffsets(targetEntry, radiusPixels = this.textureBrushRadiusScreenPixels?.() || 8) {
      const width = Math.max(1, targetEntry?.width || targetEntry?.target?.width || 1);
      const height = Math.max(1, targetEntry?.height || targetEntry?.target?.height || 1);
      const stepX = 1 / width;
      const stepY = 1 / height;
      const radius = Math.max(1, Number(radiusPixels) || 1);
      const radiusBand = radius > 16 ? "large" : radius > 9 ? "medium" : "small";
      const cacheKey = `${width}:${height}:${radiusBand}`;
      const cache = targetEntry && typeof targetEntry === "object"
        ? (targetEntry.uvBleedOffsetCache ||= new Map())
        : null;
      const cached = cache?.get(cacheKey);
      if (cached) {
        return cached;
      }
      let offsets = [[0, 0]];
      if (radius > 16) {
        offsets = [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
          [-2, 0],
          [2, 0],
          [0, -2],
          [0, 2]
        ];
      } else if (radius > 9) {
        offsets = [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ];
      }
      const vectors = offsets.map(([x, y]) => new THREE.Vector2(x * stepX, y * stepY));
      cache?.set(cacheKey, vectors);
      return vectors;
    },

    textureAirbrushRememberLayerHitSeed(event = null, hit = null, material = null) {
      if (
        !textureAirbrushActiveLayerPaintMode(this)
        || !event
        || !hit?.record
        || !material
        || !this.canvas?.getBoundingClientRect
      ) {
        return false;
      }
      const clientX = Number(event.clientX);
      const clientY = Number(event.clientY);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        return false;
      }
      const rect = this.canvas.getBoundingClientRect();
      this.textureAirbrushCachedLayerHitSeed = {
        clientX,
        clientY,
        x: clientX - (rect.left || 0),
        y: clientY - (rect.top || 0),
        record: hit.record,
        materialIndex: hit.hit?.face?.materialIndex ?? 0,
        material,
        layerMutationSerial: this.texturePaintLayerMutationSerialValue?.() ?? 0,
        cameraSerial: this.textureAirbrushCameraPrewarmSerial || 0,
        createdAt: typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()
      };
      return true;
    },

    textureAirbrushClearLayerHitSeed() {
      if (!this.textureAirbrushCachedLayerHitSeed) {
        return false;
      }
      this.textureAirbrushCachedLayerHitSeed = null;
      return true;
    },

    textureAirbrushPreferredLayerMaterial(material = null) {
      if (material) {
        return material;
      }
      const fallback = this.texturePaintActiveMaterial || this.textureAirbrushFirstPaintableMaterial?.()?.material || null;
      const seed = this.textureAirbrushCachedLayerHitSeed || null;
      if (
        !textureAirbrushActiveLayerPaintMode(this)
        || !seed?.material
        || seed.layerMutationSerial !== (this.texturePaintLayerMutationSerialValue?.() ?? 0)
        || seed.cameraSerial !== (this.textureAirbrushCameraPrewarmSerial || 0)
      ) {
        return fallback;
      }
      const now = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
      if (Number.isFinite(seed.createdAt) && now - seed.createdAt > TEXTURE_AIRBRUSH_LAYER_HIT_SEED_MAX_AGE_MS) {
        return fallback;
      }
      return seed.material || fallback;
    },

    textureAirbrushRefreshLayerHitSeedFromEvent(event = null) {
      const seed = this.textureAirbrushCachedLayerHitSeed || null;
      if (
        !seed
        || !textureAirbrushActiveLayerPaintMode(this)
        || seed.layerMutationSerial !== (this.texturePaintLayerMutationSerialValue?.() ?? 0)
        || seed.cameraSerial !== (this.textureAirbrushCameraPrewarmSerial || 0)
        || !this.canvas?.getBoundingClientRect
        || !Number.isFinite(event?.clientX)
        || !Number.isFinite(event?.clientY)
      ) {
        return false;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - (rect.left || 0);
      const y = event.clientY - (rect.top || 0);
      const radius = Math.max(1, Number(this.textureBrushRadiusScreenPixels?.()) || 8);
      const tolerance = Math.max(8, Math.min(40, radius * 1.5));
      const dx = x - seed.x;
      const dy = y - seed.y;
      if ((dx * dx) + (dy * dy) > tolerance * tolerance) {
        return false;
      }
      seed.clientX = event.clientX;
      seed.clientY = event.clientY;
      seed.x = x;
      seed.y = y;
      seed.createdAt = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
      return true;
    },

    textureAirbrushCachedLayerHitPassesForProbe(projectionFrame = null, probe = null, options = {}) {
      const seed = this.textureAirbrushCachedLayerHitSeed || null;
      if (
        !seed
        || !textureAirbrushActiveLayerPaintMode(this)
        || !projectionFrame?.paintPassCache
        || !projectionFrame?.probePaintPassCache
        || !Number.isFinite(probe?.x)
        || !Number.isFinite(probe?.y)
        || !seed.record
        || !seed.material
        || seed.layerMutationSerial !== (this.texturePaintLayerMutationSerialValue?.() ?? 0)
        || seed.cameraSerial !== (this.textureAirbrushCameraPrewarmSerial || 0)
      ) {
        return [];
      }
      const now = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
      if (Number.isFinite(seed.createdAt) && now - seed.createdAt > TEXTURE_AIRBRUSH_LAYER_HIT_SEED_MAX_AGE_MS) {
        return [];
      }
      if (Array.isArray(projectionFrame.paintRecords) && !projectionFrame.paintRecords.includes(seed.record)) {
        return [];
      }
      const radiusPixels = Math.max(1, Number(options.radiusPixels) || 1);
      const tolerance = Math.max(3, Math.min(16, radiusPixels * 0.75));
      const dx = probe.x - seed.x;
      const dy = probe.y - seed.y;
      if ((dx * dx) + (dy * dy) > tolerance * tolerance) {
        return [];
      }
      const pass = this.textureAirbrushSeedProjectionFramePaintPass?.(
        projectionFrame,
        seed.record,
        seed.materialIndex,
        seed.material,
        {
          event: { clientX: seed.clientX, clientY: seed.clientY },
          seedLayerProxy: true,
          seedProbe: true
        }
      );
      if (!pass) {
        return [];
      }
      const probeKey = `${Math.round(probe.x)}:${Math.round(probe.y)}`;
      const probePasses = projectionFrame.probePaintPassCache.get(probeKey) || [];
      if (!probePasses.some((candidate) => candidate?.key === pass.key)) {
        projectionFrame.probePaintPassCache.set(probeKey, [...probePasses, pass]);
      }
      return [pass];
    },

    scheduleTextureAirbrushPrewarm(event = null, hit = null, options = {}) {
      const force = options.force === true;
      if (!force && this.activeTool !== "airbrush") {
        return false;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const layerMode = textureAirbrushActiveLayerPaintMode(this);
      const layerHitMaterial = layerMode && hit?.record
        ? this.clonePaintMaterialForHit?.(hit.record, hit.hit) || null
        : null;
      if (event && hit?.record && layerHitMaterial) {
        this.textureAirbrushRememberLayerHitSeed?.(event, hit, layerHitMaterial);
      }
      const layerPrewarmNeeded = layerMode && this.textureAirbrushLayerPrewarmNeeded?.(layerHitMaterial, options) === true;
      const layerLiveFrameNeeded = layerMode
        && typeof this.textureAirbrushLiveProjectionFrameCurrent === "function"
        && !this.textureAirbrushLiveProjectionFrameCurrent(this.textureAirbrushLiveProjectionFrameState);
      const layerProjectionSeedNeeded = layerMode
        && !layerLiveFrameNeeded
        && this.textureAirbrushLayerProjectionFrameNeedsSeed?.(event, hit, layerHitMaterial, options) === true;
      const layerActiveProjectionSeedNeeded = layerMode
        && !layerLiveFrameNeeded
        && !hit?.record
        && this.textureAirbrushActiveLayerProjectionFrameNeedsSeed?.(layerHitMaterial || options.material || null) === true;
      const nextPrewarmOptions = mergeScheduledPrewarmOptions(
        this.textureAirbrushPendingPrewarmOptions,
        options,
        force
      );
      if (this.textureAirbrushPrewarmPending) {
        if (event) {
          this.textureAirbrushPendingPrewarmEvent = { clientX: event.clientX, clientY: event.clientY };
        }
        if (hit) {
          this.textureAirbrushPendingPrewarmHit = hit;
        }
        this.textureAirbrushPendingPrewarmOptions = nextPrewarmOptions;
        return false;
      }
      if (
        !force
        && !layerPrewarmNeeded
        && !layerLiveFrameNeeded
        && !layerProjectionSeedNeeded
        && !layerActiveProjectionSeedNeeded
        && this.textureAirbrushLastPrewarmAt
        && now - this.textureAirbrushLastPrewarmAt < 180
      ) {
        return false;
      }
      this.textureAirbrushPendingPrewarmEvent = event
        ? { clientX: event.clientX, clientY: event.clientY }
        : this.textureAirbrushPendingPrewarmEvent || null;
      this.textureAirbrushPendingPrewarmHit = hit || this.textureAirbrushPendingPrewarmHit || null;
      this.textureAirbrushPendingPrewarmOptions = nextPrewarmOptions;
      this.textureAirbrushPrewarmPending = true;
      const run = () => {
        this.textureAirbrushPrewarmPending = false;
        this.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const pendingEvent = this.textureAirbrushPendingPrewarmEvent;
        const pendingHit = this.textureAirbrushPendingPrewarmHit;
        const pendingOptions = this.textureAirbrushPendingPrewarmOptions || { force };
        this.textureAirbrushPendingPrewarmEvent = null;
        this.textureAirbrushPendingPrewarmHit = null;
        this.textureAirbrushPendingPrewarmOptions = null;
        this.textureAirbrushPrewarm?.(pendingEvent, pendingHit, pendingOptions);
      };
      const immediateLayerProjectionSeedNeeded = layerProjectionSeedNeeded
        || (!event && layerActiveProjectionSeedNeeded);
      if (
        (layerPrewarmNeeded || immediateLayerProjectionSeedNeeded || (layerLiveFrameNeeded && Boolean(hit?.record)))
        && (options.immediateLayer !== false)
      ) {
        run();
      } else if (
        !event
        && options.immediateLayer !== false
        && (layerPrewarmNeeded || layerLiveFrameNeeded || layerActiveProjectionSeedNeeded)
      ) {
        run();
      } else if (force || !event) {
        window.setTimeout(run, options.delay ?? 0);
      } else if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 120 });
      } else {
        window.setTimeout(run, 24);
      }
      return true;
    },

    textureAirbrushActiveLayerProjectionFrameNeedsSeed(material = null) {
      if (
        !textureAirbrushActiveLayerPaintMode(this)
      ) {
        return false;
      }
      const frame = this.textureAirbrushLiveProjectionFrameState || null;
      if (
        !frame
        || typeof this.textureAirbrushLiveProjectionFrameCurrent !== "function"
        || !this.textureAirbrushLiveProjectionFrameCurrent(frame)
      ) {
        return false;
      }
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (!activeMaterial) {
        return false;
      }
      const matchingPasses = [...(frame.paintPassCache?.values?.() || [])]
        .filter((pass) => pass?.material === activeMaterial && pass.targetEntry?.layerMode === true);
      if (!matchingPasses.length) {
        return true;
      }
      return !matchingPasses.some((pass) => frame.proxySceneCache?.has(pass.key));
    },

    textureAirbrushLayerProjectionFrameNeedsSeed(event = null, hit = null, material = null) {
      if (
        !textureAirbrushActiveLayerPaintMode(this)
        || !event
        || !hit?.record
        || !material
      ) {
        return false;
      }
      const frame = this.textureAirbrushLiveProjectionFrameState || null;
      if (
        !frame
        || typeof this.textureAirbrushLiveProjectionFrameCurrent !== "function"
        || !this.textureAirbrushLiveProjectionFrameCurrent(frame)
      ) {
        return false;
      }
      const matchingPasses = [...(frame.paintPassCache?.values?.() || [])]
        .filter((pass) => pass?.material === material && pass.targetEntry?.layerMode === true);
      if (!matchingPasses.length) {
        return true;
      }
      if (!matchingPasses.some((pass) => frame.proxySceneCache?.has(pass.key))) {
        return true;
      }
      if (!frame.probePaintPassCache || !frame.rect) {
        return false;
      }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        return false;
      }
      const probeKey = `${Math.round(event.clientX - (frame.rect.left || 0))}:${Math.round(event.clientY - (frame.rect.top || 0))}`;
      const probePasses = frame.probePaintPassCache.get(probeKey) || [];
      return !probePasses.some((pass) => pass?.material === material && pass.targetEntry?.layerMode === true);
    },

    textureAirbrushLayerPrewarmNeeded(material = null, options = {}) {
      if (!textureAirbrushActiveLayerPaintMode(this)) {
        return false;
      }
      const paintables = this.textureAirbrushPaintableMaterials?.() || [];
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || null;
      const relevantPaintables = options.all === true
        ? paintables
        : activeMaterial
          ? paintables.filter((paintable) => paintable.material === activeMaterial)
          : paintables.slice(0, 1);
      const candidates = relevantPaintables.length
        ? relevantPaintables
        : activeMaterial
          ? [{ material: activeMaterial }]
          : [];
      if (!candidates.length) {
        return false;
      }
      const primaryMaterial = activeMaterial || candidates[0]?.material || null;
      for (const paintable of candidates) {
        const candidateMaterial = paintable.material;
        const stack = candidateMaterial?.userData?.texturePaintLayerStack || null;
        const layer = stack?.layers?.find((item) => item.id === stack.activeLayerId)
          || stack?.layers?.[stack.layers.length - 1]
          || null;
        if (!layer?.gpuTarget?.target?.texture) {
          return true;
        }
        const shouldCheckStrokeSource = candidateMaterial === primaryMaterial
          || options.material === candidateMaterial
          || options.all === true
          || (!primaryMaterial && candidates[0]?.material === candidateMaterial);
        const sourceIsClear = texturePaintLayerEffectivelyEmpty(layer);
        if (
          shouldCheckStrokeSource
          && !sourceIsClear
          && !this.texturePaintStrokeUndo
          && typeof this.texturePaintGpuPrewarmSnapshotCurrent === "function"
          && !this.texturePaintGpuPrewarmSnapshotCurrent(layer.gpuTarget)
        ) {
          return true;
        }
        if (this.texturePaintLayerCanUseLiveShaderComposite?.(candidateMaterial, layer.gpuTarget)) {
          if (!candidateMaterial?.userData?.texturePaintLiveLayerShaderComposite) {
            return true;
          }
          if (
            candidateMaterial.userData.texturePaintLiveLayerShaderCompileKey
              !== liveLayerShaderCompileKey(layer.gpuTarget)
          ) {
            return true;
          }
          if (!this.texturePaintCachedLiveLayerShaderComposite?.(candidateMaterial, layer.gpuTarget)) {
            return true;
          }
          continue;
        }
        if (this.texturePaintLiveUnderlayTargetForLayerGpuPaint?.(candidateMaterial, layer.gpuTarget, {
          cachedOnly: true
        })) {
          continue;
        }
        const composite = candidateMaterial.userData?.texturePaintCompositeGpuTarget || null;
        if (
          !composite?.target?.texture
          || composite.width !== layer.gpuTarget.width
          || composite.height !== layer.gpuTarget.height
        ) {
          return true;
        }
      }
      return false;
    },

    textureAirbrushLayerTargetReadyForLiveReset(material = null) {
      if (!textureAirbrushActiveLayerPaintMode(this)) {
        return false;
      }
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (!activeMaterial) {
        return false;
      }
      const stack = activeMaterial.userData?.texturePaintLayerStack || null;
      const layer = stack?.layers?.find((item) => item.id === stack.activeLayerId)
        || stack?.layers?.[stack.layers.length - 1]
        || null;
      const targetEntry = layer?.gpuTarget || null;
      if (!targetEntry?.target?.texture) {
        return false;
      }
      const sourceReady = texturePaintLayerEffectivelyEmpty(layer)
        || this.texturePaintGpuPrewarmSnapshotCurrent?.(targetEntry) === true;
      if (!sourceReady) {
        return false;
      }
      if (this.texturePaintLayerCanUseLiveShaderComposite?.(activeMaterial, targetEntry)) {
        return Boolean(this.texturePaintCachedLiveLayerShaderComposite?.(activeMaterial, targetEntry));
      }
      if (this.texturePaintLiveUnderlayTargetForLayerGpuPaint?.(activeMaterial, targetEntry, {
        cachedOnly: true
      })) {
        return true;
      }
      const composite = activeMaterial.userData?.texturePaintCompositeGpuTarget || null;
      return Boolean(
        composite?.target?.texture
        && composite.width === targetEntry.width
        && composite.height === targetEntry.height
      );
    },

    textureAirbrushLayerPaintTargetReadyForLiveReset(material = null) {
      if (!textureAirbrushActiveLayerPaintMode(this)) {
        return false;
      }
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (!activeMaterial) {
        return false;
      }
      const stack = activeMaterial.userData?.texturePaintLayerStack || null;
      const layer = stack?.layers?.find((item) => item.id === stack.activeLayerId)
        || stack?.layers?.[stack.layers.length - 1]
        || null;
      const targetEntry = layer?.gpuTarget || null;
      if (!targetEntry?.target?.texture) {
        return false;
      }
      return texturePaintLayerEffectivelyEmpty(layer)
        || this.texturePaintGpuPrewarmSnapshotCurrent?.(targetEntry) === true;
    },

    textureAirbrushPaintableMaterials() {
      const paintables = [];
      const records = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      for (const record of records) {
        const materials = materialsForAirbrushRecord(record);
        for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
          const material = materials[materialIndex];
          if (material && (material.map || material.color)) {
            paintables.push({
              record,
              materialIndex,
              material
            });
          }
        }
      }
      return paintables;
    },

    textureAirbrushFirstPaintableMaterial() {
      return this.textureAirbrushPaintableMaterials?.()[0] || null;
    },

    textureAirbrushPrewarmWebGlMaterial(record = null, materialIndex = 0, material = null) {
      if (!record || !material) {
        return false;
      }
      const targetEntry = this.textureAirbrushGpuTargetForMaterial?.(material);
      if (!targetEntry) {
        return false;
      }
      const proxyEntry = this.textureAirbrushGpuProxyForRecord?.(record, materialIndex, material);
      this.textureAirbrushPrecompileBrushProxyScene?.(proxyEntry);
      return true;
    },

    textureAirbrushPrewarmLayerMaterial(record = null, materialIndex = 0, material = null, options = {}) {
      if (!material || !this.renderer) {
        return false;
      }
      const targetEntry = this.textureAirbrushGpuLayerTargetForMaterial?.(material, {
        renderPanel: false,
        setActiveMaterial: false
      });
      if (!targetEntry) {
        return false;
      }
      if (options.preserveLayerDisplay !== true) {
        this.texturePaintLiveCompositeTargetForLayerGpuPaint?.(material, targetEntry)
          || this.texturePaintLiveUnderlayTargetForLayerGpuPaint?.(material, targetEntry)
          || this.texturePaintCompositeMaterialLayerGpuTargets?.(material);
      }
      this.textureAirbrushPrewarmUvBleedOffsets?.(targetEntry);
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(options.material)
        || options.material
        || this.texturePaintActiveMaterial
        || null;
      if (
        options.strokeSource !== false
        && (
          material === activeMaterial
          || options.material === material
          || (record && options.all !== true)
        )
      ) {
        this.prewarmTexturePaintGpuStrokeSourceSnapshot?.(targetEntry, {
          allowDuringStroke: options.allowDuringStroke === true
        });
        this.textureAirbrushPrewarmCurrentTargetSnapshot?.(targetEntry);
      }
      if (record) {
        const proxyEntry = this.textureAirbrushGpuProxyForRecord?.(record, materialIndex, material);
        this.textureAirbrushPrecompileBrushProxyScene?.(proxyEntry);
      }
      return true;
    },

    textureAirbrushPrewarmAllWebGlMaterials(options = {}) {
      const paintables = this.textureAirbrushPaintableMaterials?.() || [];
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // Broad post-camera/Neighbor rewarm must make every material slot ready
      // before the first stroke, but this is only shader/proxy warming. It must
      // never broaden paint beyond the current visible-depth/camera-facing
      // gates in the airbrush shader.
      const limit = options.limit !== undefined
        ? Math.max(1, Number(options.limit) || 1)
        : options.all === true
          ? Math.max(1, paintables.length)
          : 12;
      let warmed = 0;
      for (const paintable of paintables.slice(0, limit)) {
        if (this.textureAirbrushPrewarmWebGlMaterial?.(
          paintable.record,
          paintable.materialIndex,
          paintable.material
        )) {
          warmed += 1;
        }
      }
      return warmed;
    },

    textureAirbrushPrewarmAllLayerMaterials(options = {}) {
      const paintables = this.textureAirbrushPaintableMaterials?.() || [];
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(options.material)
        || options.material
        || this.texturePaintActiveMaterial
        || null;
      const orderedPaintables = activeMaterial
        ? [
            ...paintables.filter((paintable) => paintable.material === activeMaterial),
            ...paintables.filter((paintable) => paintable.material !== activeMaterial)
          ]
        : paintables;
      const activeOnly = options.activeOnly === true;
      const limit = activeOnly
        ? 1
        : Math.max(1, Number(options.limit) || 12);
      const primaryMaterial = activeMaterial || orderedPaintables[0]?.material || null;
      const prewarmOptions = primaryMaterial && !options.material
        ? { ...options, material: primaryMaterial }
        : options;
      let warmed = 0;
      for (const paintable of orderedPaintables.slice(0, limit)) {
        const materialPrewarmOptions = options.all === true && !activeOnly
          ? { ...prewarmOptions, material: paintable.material }
          : prewarmOptions;
        if (this.textureAirbrushPrewarmLayerMaterial?.(
          paintable.record,
          paintable.materialIndex,
          paintable.material,
          materialPrewarmOptions
        )) {
          warmed += 1;
        }
      }
      if (!warmed && activeMaterial) {
        warmed += this.textureAirbrushPrewarmLayerMaterial?.(null, 0, activeMaterial, options) ? 1 : 0;
      }
      return warmed;
    },

    textureAirbrushCanPrewarmDepthTarget() {
      const depthPrewarmIsStubbed = Object.prototype.hasOwnProperty.call(this, "textureAirbrushRenderDepthTarget")
        && this.textureAirbrushRenderDepthTarget !== BirdWeightEditor.prototype.textureAirbrushRenderDepthTarget;
      return depthPrewarmIsStubbed || Boolean(
        this.scene
        && this.camera
        && this.renderer?.setRenderTarget
        && this.renderer?.render
        && typeof THREE.WebGLRenderTarget === "function"
      );
    },

    textureAirbrushPrewarmDepthTargetForProjectionFrame(projectionFrame = null) {
      if (!projectionFrame || !this.textureAirbrushCanPrewarmDepthTarget?.()) {
        return false;
      }
      const depthTarget = this.textureAirbrushRenderDepthTarget?.({ reuse: true }) || null;
      if (!depthTarget) {
        return false;
      }
      projectionFrame.depthTarget = depthTarget;
      return true;
    },

    prewarmTexturePaintActiveLayerGpu(material = null, options = {}) {
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (!activeMaterial || !this.renderer) {
        return false;
      }
      const paintable = (this.textureAirbrushPaintableMaterials?.() || [])
        .find((candidate) => candidate.material === activeMaterial);
      if (options.all !== false && textureAirbrushActiveLayerPaintMode(this)) {
        const prewarmOptions = {
          material: activeMaterial,
          activeOnly: options.all !== true,
          ...(options.all === true ? { all: true } : {}),
          ...(options.preserveLayerDisplay === true ? { preserveLayerDisplay: true } : {})
        };
        if (options.limit !== undefined) {
          prewarmOptions.limit = options.limit;
        }
        const warmed = (this.textureAirbrushPrewarmAllLayerMaterials?.(prewarmOptions) || 0) > 0;
        if (warmed) {
          this.textureAirbrushBrushShaderMaterial?.();
          this.textureAirbrushEnsureCopyScene?.();
          const liveFrameOptions = options.all === true
            ? {}
            : { seedLayerProxies: false, seedPaintPasses: false };
          const liveFrame = this.textureAirbrushLiveProjectionFrame?.(liveFrameOptions);
          if (liveFrame && paintable?.record) {
            this.textureAirbrushPrewarmDepthTargetForProjectionFrame?.(liveFrame);
            this.textureAirbrushSeedProjectionFramePaintPass?.(
              liveFrame,
              paintable.record,
              paintable.materialIndex || 0,
              activeMaterial,
              {
                seedLayerProxy: true,
                seedProbe: false
              }
            );
          }
        }
        return warmed;
      }
      return this.textureAirbrushPrewarmLayerMaterial?.(
        paintable?.record || null,
        paintable?.materialIndex || 0,
        activeMaterial,
        options.preserveLayerDisplay === true ? { preserveLayerDisplay: true } : {}
      ) || false;
    },

    prewarmTexturePaintActiveLayerMaterialGpu(material = null, options = {}) {
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (
        !activeMaterial
        || !this.renderer
        || !textureAirbrushActiveLayerPaintMode(this)
      ) {
        return false;
      }
      const paintable = (this.textureAirbrushPaintableMaterials?.() || [])
        .find((candidate) => candidate.material === activeMaterial) || null;
      const warmed = this.textureAirbrushPrewarmLayerMaterial?.(
        paintable?.record || null,
        paintable?.materialIndex || 0,
        activeMaterial,
        {
          material: activeMaterial,
          activeOnly: true,
          allowDuringStroke: options.allowDuringStroke === true,
          ...(options.preserveLayerDisplay === true ? { preserveLayerDisplay: true } : {})
        }
      ) === true;
      if (!warmed) {
        return false;
      }
      this.textureAirbrushBrushShaderMaterial?.();
      this.textureAirbrushEnsureCopyScene?.();
      return true;
    },

    prewarmTexturePaintActiveLayerProjectionGpu(material = null) {
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (
        !activeMaterial
        || !this.renderer
        || !this.canvas
        || !this.camera
        || !this.model
        || !textureAirbrushActiveLayerPaintMode(this)
      ) {
        return false;
      }
      const paintable = (this.textureAirbrushPaintableMaterials?.() || [])
        .find((candidate) => candidate.material === activeMaterial) || null;
      if (!paintable?.record) {
        return false;
      }
      const frame = this.textureAirbrushLiveProjectionFrame?.({
        seedLayerProxies: false,
        seedPaintPasses: false
      });
      if (!frame?.paintPassCache || !frame.proxySceneCache) {
        return false;
      }
      this.textureAirbrushPrewarmDepthTargetForProjectionFrame?.(frame);
      return Boolean(this.textureAirbrushSeedProjectionFramePaintPass?.(
        frame,
        paintable.record,
        paintable.materialIndex || 0,
        activeMaterial,
        {
          seedLayerProxy: true,
          seedProbe: false
        }
      ));
    },

    prewarmTextureAirbrushLayerResetStroke(payloadOrMaterial = null, materialOverride = null) {
      if (
        !textureAirbrushActiveLayerPaintMode(this)
        || !this.renderer
        || !this.model
      ) {
        return false;
      }
      const resetPayload = Number.isFinite(Number(payloadOrMaterial?.clientX))
        && Number.isFinite(Number(payloadOrMaterial?.clientY))
        ? payloadOrMaterial
        : null;
      const material = materialOverride || (resetPayload ? null : payloadOrMaterial) || null;
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || this.textureAirbrushFirstPaintableMaterial?.()?.material
        || null;
      if (!activeMaterial) {
        return false;
      }
      const paintable = (this.textureAirbrushPaintableMaterials?.() || [])
        .find((candidate) => candidate.material === activeMaterial);
      if (!paintable?.record) {
        return false;
      }
      const warmed = this.textureAirbrushPrewarmLayerMaterial?.(
        paintable.record,
        paintable.materialIndex || 0,
        activeMaterial,
        {
          material: activeMaterial,
          allowDuringStroke: true
        }
      ) === true;
      if (!warmed) {
        return false;
      }
      this.textureAirbrushBrushShaderMaterial?.();
      this.textureAirbrushEnsureCopyScene?.();
      const liveFrame = this.textureAirbrushLiveProjectionFrame?.({
        seedLayerProxies: false,
        seedPaintPasses: false
      });
      if (!liveFrame) {
        return warmed;
      }
      this.textureAirbrushPrewarmDepthTargetForProjectionFrame?.(liveFrame);
      this.textureAirbrushSeedProjectionFramePaintPass?.(
        liveFrame,
        paintable.record,
        paintable.materialIndex || 0,
        activeMaterial,
        {
          event: resetPayload,
          seedLayerProxy: true,
          seedProbe: Boolean(resetPayload)
        }
      );
      return true;
    },

    prewarmTexturePaintActiveLayerCursorProbe(material = null) {
      const event = this.lastBrushCursorEvent || null;
      if (
        !event
        || !Number.isFinite(Number(event.clientX))
        || !Number.isFinite(Number(event.clientY))
      ) {
        return false;
      }
      return this.prewarmTextureAirbrushLayerResetStroke?.({
        clientX: event.clientX,
        clientY: event.clientY
      }, material) === true;
    },

    prewarmTexturePaintActiveLayerStrokeSource(material = null) {
      const activeMaterial = this.textureAirbrushPreferredLayerMaterial?.(material)
        || material
        || this.texturePaintActiveMaterial
        || null;
      if (
        !activeMaterial
        || !this.renderer
        || !textureAirbrushActiveLayerPaintMode(this)
        || this.texturePaintStrokeUndo
      ) {
        return false;
      }
      const targetEntry = this.textureAirbrushGpuLayerTargetForMaterial?.(activeMaterial, {
        renderPanel: false,
        setActiveMaterial: false
      });
      if (!targetEntry?.target?.texture) {
        return false;
      }
      return this.prewarmTexturePaintGpuStrokeSourceSnapshot?.(targetEntry) === true;
    },

    scheduleTextureAirbrushPostStrokePrewarm() {
      if (
        this.textureAirbrushPostStrokePrewarmPending
        || !textureAirbrushActiveLayerPaintMode(this)
        || !this.renderer
      ) {
        return false;
      }
      const host = typeof window !== "undefined" ? window : globalThis;
      const schedule = typeof host.requestAnimationFrame === "function"
          ? (callback) => host.requestAnimationFrame(() => callback())
        : typeof host.requestIdleCallback === "function"
          ? (callback) => host.requestIdleCallback(callback, { timeout: 80 })
          : typeof host.setTimeout === "function"
            ? (callback) => host.setTimeout(callback, 0)
            : null;
      if (!schedule) {
        return false;
      }
      this.textureAirbrushPostStrokePrewarmPending = true;
      schedule(() => {
        this.textureAirbrushPostStrokePrewarmPending = false;
        if (
          this.painting
          || this.textureAirbrushScreenStrokeHasPendingWork?.()
        ) {
          this.scheduleTextureAirbrushPostStrokePrewarm?.();
          return;
        }
        if (
          !textureAirbrushActiveLayerPaintMode(this)
        ) {
          return;
        }
        this.prewarmTexturePaintActiveLayerStrokeSource?.();
      });
      return true;
    },

    textureAirbrushPrewarm(event = null, hit = null, options = {}) {
      if (!this.renderer || !this.model || (!options.force && this.activeTool !== "airbrush")) {
        return false;
      }
      this.textureAirbrushBrushShaderMaterial?.();
      this.textureAirbrushEnsureCopyScene?.();
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // Post-orbit recovery is a warming problem, not permission to paint
      // through the model. When a caller asks for all:true, keep the prewarm
      // broad even if there is a cursor hit; otherwise a rotated Neighbor reset
      // can warm only the first-hit material and leave the next visible surface
      // spotty/cold.
      const broadPrewarm = options.all === true;
      const paintHit = broadPrewarm
        ? null
        : hit || (event ? this.texturePaintHitForEvent?.(event, "airbrush") : null);
      const record = paintHit?.record;
      const materialIndex = paintHit?.hit?.face?.materialIndex ?? 0;
      const material = record ? this.clonePaintMaterialForHit?.(record, paintHit.hit) : null;
      let warmed = false;
      const layerMode = textureAirbrushActiveLayerPaintMode(this);
      if (!layerMode) {
        this.textureAirbrushRenderDepthTarget?.();
      }
      if (layerMode) {
        warmed = !broadPrewarm && record && material
          ? this.textureAirbrushPrewarmLayerMaterial?.(record, materialIndex, material, options) || false
          : (this.textureAirbrushPrewarmAllLayerMaterials?.({
              ...options,
              activeOnly: !broadPrewarm
            }) || 0) > 0;
      } else if (!broadPrewarm && record && material) {
        this.textureAirbrushPrewarmWebGlMaterial?.(record, materialIndex, material);
        this.textureAirbrushPrewarmWebGpuFromHit?.(paintHit);
        warmed = true;
      } else {
        this.textureAirbrushPrewarmAllWebGlMaterials?.(options);
        this.textureAirbrushPrewarmAllWebGpuPaintables?.(options);
        warmed = true;
      }
      if (warmed) {
        const liveFrameOptions = layerMode
          ? options.all === true
            ? {}
            : { seedLayerProxies: false, seedPaintPasses: false }
          : {};
        const liveFrame = this.textureAirbrushLiveProjectionFrame?.(liveFrameOptions);
        const preferredLayerMaterial = this.textureAirbrushPreferredLayerMaterial?.(options.material)
          || options.material
          || this.texturePaintActiveMaterial
          || null;
        const activeLayerPaintables = layerMode && (!record || !material)
          ? this.textureAirbrushPaintableMaterials?.() || []
          : [];
        const activeLayerPaintable = activeLayerPaintables.find(
          (candidate) => candidate.material === preferredLayerMaterial
        ) || activeLayerPaintables[0] || null;
        const seedRecord = record || activeLayerPaintable?.record || null;
        const seedMaterial = material || activeLayerPaintable?.material || preferredLayerMaterial || null;
        const seedMaterialIndex = record ? materialIndex : activeLayerPaintable?.materialIndex || 0;
        if (layerMode && liveFrame && seedRecord && seedMaterial) {
          this.textureAirbrushPrewarmDepthTargetForProjectionFrame?.(liveFrame);
          this.textureAirbrushSeedProjectionFramePaintPass?.(liveFrame, seedRecord, seedMaterialIndex, seedMaterial, {
            event,
            seedLayerProxy: true,
            seedProbe: Boolean(record && material)
          });
        }
      }
      return warmed;
    },

    textureAirbrushEnsureCopyScene() {
      if (this.textureAirbrushGpuCopyScene) {
        return;
      }
      this.textureAirbrushGpuCopyScene = new THREE.Scene();
      this.textureAirbrushGpuCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      this.textureAirbrushGpuCopyCamera.position.z = 1;
      this.textureAirbrushGpuCopyMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial()
      );
      this.textureAirbrushGpuCopyMesh.frustumCulled = false;
      this.textureAirbrushGpuCopyScene.add(this.textureAirbrushGpuCopyMesh);
    },

    textureAirbrushEnsureDepthTarget() {
      if (!this.renderer || !this.canvas) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const pixelRatio = this.renderer.getPixelRatio?.() || 1;
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));
      const existing = this.textureAirbrushGpuDepthTarget;
      if (existing?.width === width && existing?.height === height) {
        return existing;
      }
      existing?.dispose?.();
      this.textureAirbrushDepthTargetKey = "";
      const target = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false
      });
      target.texture.name = "texture airbrush visible surface normals";
      target.depthTexture = new THREE.DepthTexture(width, height);
      target.depthTexture.name = "texture airbrush screen depth";
      target.depthTexture.format = THREE.DepthFormat;
      target.depthTexture.type = THREE.UnsignedShortType;
      this.textureAirbrushGpuDepthTarget = target;
      return target;
    },

    textureAirbrushDepthCacheKey(rect = this.canvas?.getBoundingClientRect?.()) {
      if (!rect || !this.camera || !this.renderer) {
        return "";
      }
      this.camera.updateMatrixWorld?.(true);
      const inverseElements = this.camera.matrixWorldInverse?.elements;
      const projectionElements = this.camera.projectionMatrix?.elements;
      if (
        !inverseElements
        || !projectionElements
        || typeof inverseElements[Symbol.iterator] !== "function"
        || typeof projectionElements[Symbol.iterator] !== "function"
      ) {
        return "";
      }
      const pixelRatio = this.renderer.getPixelRatio?.() || 1;
      const matrixKey = [
        ...inverseElements,
        ...projectionElements
      ].map((value) => stableDepthCacheNumber(value, 7)).join(",");
      return [
        Math.round(rect.width * pixelRatio),
        Math.round(rect.height * pixelRatio),
        stableDepthCacheNumber(this.progress || 0, 5),
        matrixKey
      ].join(":");
    },

    textureAirbrushRenderDepthTarget(options = {}) {
      const depthTarget = this.textureAirbrushEnsureDepthTarget();
      if (!depthTarget || !this.renderer || !this.scene || !this.camera) {
        return null;
      }
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // The depth buffer is the visible-surface authority for every airbrush
      // mode. Before reusing or refreshing it after an orbit/camera change,
      // force the scene/model/camera matrices current; stale depth is a
      // coverage bug, and the fix is fresh visible depth, never hidden-side
      // paint.
      this.model?.updateMatrixWorld?.(true);
      this.scene?.updateMatrixWorld?.(true);
      this.camera?.updateMatrixWorld?.(true);
      this.refreshSkinnedRaycastBounds?.();
      const key = this.textureAirbrushDepthCacheKey();
      if (options.reuse !== false && key && this.textureAirbrushDepthTargetKey === key) {
        return depthTarget;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousOverrideMaterial = this.scene.overrideMaterial || null;
      const normalMaterial = this.textureAirbrushVisibleSurfaceNormalMaterial?.() || null;
      this.renderer.setRenderTarget(depthTarget);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      // DO NOT PAINT ON NON CAMERA FACING SIDES.
      // The color attachment stores front-visible camera-facing normals, while
      // the depth attachment stores the matching front-visible depth. The paint
      // shader uses both so a depth-close side/back fragment cannot masquerade
      // as the visible surface.
      if (normalMaterial) {
        this.scene.overrideMaterial = normalMaterial;
      }
      try {
        this.renderer.render(this.scene, this.camera);
      } finally {
        this.scene.overrideMaterial = previousOverrideMaterial;
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.autoClear = previousAutoClear;
      }
      this.textureAirbrushDepthTargetKey = key;
      return depthTarget;
    },

    textureAirbrushGpuTargetForMaterial(material) {
      if (!material) {
        return null;
      }
      if (textureAirbrushActiveLayerPaintMode(this)) {
        const layerTarget = this.textureAirbrushGpuLayerTargetForMaterial?.(material);
        if (layerTarget) {
          return layerTarget;
        }
      }
      const existing = material.userData?.textureAirbrushGpuTarget;
      if (existing?.target?.texture && material.map === existing.target.texture) {
        return existing;
      }
      const editable = this.editableClonePaintTexture?.(material);
      const sourceTexture = editable?.texture || material.map;
      if (!sourceTexture) {
        return null;
      }
      if (existing?.texture === sourceTexture || existing?.target?.texture === sourceTexture) {
        return existing;
      }
      const baseTexture = existing?.target?.texture === sourceTexture
        ? existing.sourceTexture
        : sourceTexture;
      const size = this.textureAirbrushRenderTargetSizeForTexture(baseTexture);
      const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
      const target = new THREE.WebGLRenderTarget(size.width, size.height, {
        minFilter: settings.minFilter,
        magFilter: settings.magFilter,
        wrapS: settings.wrapS,
        wrapT: settings.wrapT,
        depthBuffer: false,
        stencilBuffer: false
      });
      target.texture.name = `${baseTexture.name || "texture"} airbrush paint`;
      this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);

      if (!this.textureAirbrushCopyTextureToTarget(baseTexture, target)) {
        target.dispose?.();
        return null;
      }

      const entry = {
        sourceTexture: baseTexture,
        target,
        width: size.width,
        height: size.height,
        paintRevision: 0
      };
      material.map = target.texture;
      material.needsUpdate = true;
      material.userData.textureAirbrushGpuTarget = entry;
      return entry;
    },

    textureAirbrushGpuLayerTargetForMaterial(material, options = {}) {
      if (!material || !this.renderer) {
        return null;
      }
      material.userData ||= {};
      let baseEditable = material.userData.clonePaintCanvas && material.userData.clonePaintContext
        ? {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          }
        : null;
      if (!baseEditable) {
        baseEditable = this.editableClonePaintTexture?.(material);
        if (material.userData.clonePaintCanvas && material.userData.clonePaintContext) {
          baseEditable = {
            canvas: material.userData.clonePaintCanvas,
            context: material.userData.clonePaintContext,
            texture: material.userData.clonePaintTexture || material.map
          };
        }
      }
      const stack = this.texturePaintLayerStackForMaterial?.(material, baseEditable, {
        create: true,
        setActiveMaterial: false
      });
      const active = this.texturePaintEnsureActiveLayerForStack?.(stack)
        || (
          this.texturePaintBackgroundSelectionActive === true
            ? null
            : this.texturePaintActivePaintLayerForStack?.(stack, { fallback: false })
        )
        || null;
      const layerStack = active?.stack;
      const layer = active?.layer;
      if (!layerStack?.baseCanvas || !layer?.canvas) {
        if (options.setActiveMaterial !== false) {
          this.texturePaintActiveMaterial = material;
        }
        return null;
      }
      const sourceTexture = material.userData.clonePaintTexture || baseEditable?.texture || material.map;
      const layerTexture = this.textureAirbrushCanvasTextureForLayerCanvas(layer, "gpuLayer", layer.canvas, sourceTexture);
      if (!layerTexture) {
        return null;
      }
      const existing = layer.gpuTarget;
      if (existing?.target?.texture && existing.sourceTexture === layerTexture) {
        existing.material = material;
        existing.layer = layer;
        existing.layerStack = layerStack;
        existing.layerMode = true;
        existing.emptyTransparent = texturePaintLayerEffectivelyEmpty(layer);
        if (options.setActiveMaterial !== false) {
          this.texturePaintActiveMaterial = material;
        }
        return existing;
      }
      this.disposeTexturePaintGpuPrewarmSnapshot?.(existing);
      existing?.target?.dispose?.();
      const settings = this.textureAirbrushRenderTextureSettings(layerTexture);
      const target = new THREE.WebGLRenderTarget(layerStack.width || layer.canvas.width, layerStack.height || layer.canvas.height, {
        minFilter: settings.minFilter,
        magFilter: settings.magFilter,
        wrapS: settings.wrapS,
        wrapT: settings.wrapT,
        depthBuffer: false,
        stencilBuffer: false
      });
      target.texture.name = `${layer.name || "paint layer"} airbrush paint`;
      this.textureAirbrushCopyTextureRenderSettings(target.texture, layerTexture);
      const entry = {
        sourceTexture: layerTexture,
        target,
        width: target.width,
        height: target.height,
        material,
        layer,
        layerStack,
        layerMode: true,
        emptyTransparent: layer.isEmpty === true,
        paintRevision: 0
      };
      layer.gpuTarget = entry;
      const initialized = layer.isEmpty === true && typeof this.clearTexturePaintGpuTarget === "function"
        ? this.clearTexturePaintGpuTarget(entry, { markMutated: false })
        : this.textureAirbrushCopyTextureToTarget(layerTexture, target);
      if (!initialized) {
        target.dispose?.();
        delete layer.gpuTarget;
        return null;
      }
      if (options.setActiveMaterial !== false) {
        this.texturePaintActiveMaterial = material;
      }
      return entry;
    },

    queueTexturePaintLayerGpuComposite(material = null) {
      if (!material) {
        return false;
      }
      this.texturePaintDeferredLayerCompositeMaterials ||= new Set();
      this.texturePaintDeferredLayerCompositeMaterials.add(material);
      return true;
    },

    flushTexturePaintDeferredLayerComposites() {
      const materials = [...(this.texturePaintDeferredLayerCompositeMaterials || [])];
      this.texturePaintDeferredLayerCompositeMaterials?.clear?.();
      if (!materials.length) {
        return 0;
      }
      let composited = 0;
      for (const material of materials) {
        if (this.texturePaintFastMaterialLayerDisplay?.(material, { forceLiveUnderlay: true }) === true) {
          continue;
        }
        if (this.texturePaintCompositeMaterialLayerGpuTargets?.(material)) {
          composited += 1;
        }
      }
      return composited;
    },

    texturePaintLiveCompositeTargetForLayerGpuPaint(material = null, targetEntry = null) {
      if (!material?.userData || !targetEntry?.layerMode || !targetEntry?.target?.texture) {
        return null;
      }
      if (this.texturePaintMaterialRequiresExactLayerDisplay?.(material)) {
        return null;
      }
      const fastCached = this.texturePaintFastCachedLiveLayerShaderComposite?.(material, targetEntry);
      if (fastCached) {
        return fastCached;
      }
      const stack = targetEntry.layerStack || material.userData.texturePaintLayerStack || null;
      const layer = targetEntry.layer || null;
      const layers = stack?.layers || [];
      const layerIndex = layers.indexOf(layer);
      if (layerIndex < 0 || layer?.visible === false) {
        return null;
      }
      for (let index = layerIndex + 1; index < layers.length; index += 1) {
        const upperLayer = layers[index];
        if (texturePaintLayerContributesVisiblePaint(upperLayer)) {
          return null;
        }
      }
      const cachedShaderComposite = this.texturePaintCachedLiveLayerShaderComposite?.(material, targetEntry);
      if (cachedShaderComposite) {
        return cachedShaderComposite;
      }
      const shaderComposite = this.texturePaintLiveLayerShaderCompositeForLayerGpuPaint?.(material, targetEntry);
      if (shaderComposite) {
        return shaderComposite;
      }
      let composite = material.userData.texturePaintCompositeGpuTarget || null;
      if (!composite?.target?.texture && !this.texturePaintCompositeMaterialLayerGpuTargets?.(material)) {
        return null;
      }
      composite = material.userData.texturePaintCompositeGpuTarget || null;
      if (!composite?.target?.texture || composite.width !== targetEntry.width || composite.height !== targetEntry.height) {
        return null;
      }
      if (material.map !== composite.target.texture) {
        material.map = composite.target.texture;
        material.needsUpdate = true;
      }
      return composite;
    },

    texturePaintCompositeMaterialLayerGpuTargets(material) {
      if (!material?.userData?.texturePaintLayerStack || !this.renderer) {
        return false;
      }
      const userData = material.userData;
      const stack = userData.texturePaintLayerStack;
      const sourceTexture = userData.clonePaintTexture || material.map || userData.clonePaintOriginalMap || null;
      const baseTexture = this.textureAirbrushCanvasTextureForLayerCanvas(stack, "base", stack.baseCanvas, sourceTexture);
      if (!baseTexture) {
        return false;
      }
      this.texturePaintDisableLiveLayerShaderComposite?.(material);
      let composite = userData.texturePaintCompositeGpuTarget || null;
      if (!composite?.target?.texture || composite.width !== stack.width || composite.height !== stack.height) {
        composite?.target?.dispose?.();
        composite?.scratchTarget?.dispose?.();
        composite?.stagingTarget?.dispose?.();
        const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
        const target = new THREE.WebGLRenderTarget(stack.width, stack.height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        target.texture.name = `${material.name || "material"} texture layer composite`;
        this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);
        composite = {
          target,
          scratchTarget: null,
          stagingTarget: null,
          width: stack.width,
          height: stack.height
        };
        userData.texturePaintCompositeGpuTarget = composite;
      }
      const ensureScratchTarget = () => {
        if (composite.scratchTarget?.texture) {
          return composite.scratchTarget;
        }
        const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
        const target = new THREE.WebGLRenderTarget(stack.width, stack.height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        target.texture.name = `${material.name || "material"} texture layer blend composite`;
        this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);
        composite.scratchTarget = target;
        return target;
      };
      const ensureStagingTarget = () => {
        if (composite.stagingTarget?.texture) {
          return composite.stagingTarget;
        }
        const settings = this.textureAirbrushRenderTextureSettings(baseTexture);
        const target = new THREE.WebGLRenderTarget(stack.width, stack.height, {
          minFilter: settings.minFilter,
          magFilter: settings.magFilter,
          wrapS: settings.wrapS,
          wrapT: settings.wrapT,
          depthBuffer: false,
          stencilBuffer: false
        });
        target.texture.name = `${material.name || "material"} texture layer staging composite`;
        this.textureAirbrushCopyTextureRenderSettings(target.texture, baseTexture);
        composite.stagingTarget = target;
        return target;
      };
      const displayedTexture = material.map || null;
      const displayedTarget = [
        composite.target,
        composite.scratchTarget,
        composite.stagingTarget
      ].find((candidate) => candidate?.texture && candidate.texture === displayedTexture) || null;
      const inactiveTargetFor = (currentTarget = null) => {
        const candidates = [composite.target, composite.scratchTarget].filter((candidate) => (
          candidate?.texture
          && candidate !== currentTarget
          && candidate !== displayedTarget
        ));
        if (candidates.length) {
          return candidates[0];
        }
        const stagingTarget = ensureStagingTarget();
        if (stagingTarget !== currentTarget && stagingTarget !== displayedTarget) {
          return stagingTarget;
        }
        return currentTarget === composite.target ? ensureScratchTarget() : composite.target;
      };
      this.textureAirbrushEnsureCopyScene?.();
      if (!this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera || !this.textureAirbrushGpuCopyMesh) {
        return false;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousClearAlpha = typeof this.renderer.getClearAlpha === "function"
        ? this.renderer.getClearAlpha()
        : 1;
      const previousClearColor = new THREE.Color();
      if (typeof this.renderer.getClearColor === "function") {
        this.renderer.getClearColor(previousClearColor);
      }
      const renderTexture = (texture, opacity = 1, target = composite.target) => {
        if (!texture) {
          return;
        }
        const copyMaterial = this.textureAirbrushLayerCompositeMaterial(opacity);
        copyMaterial.map = texture;
        copyMaterial.needsUpdate = true;
        this.textureAirbrushGpuCopyMesh.material = copyMaterial;
        this.renderer.setRenderTarget(target);
        this.textureAirbrushWithRawTextureMatrix(texture, () => {
          this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
        });
      };
      const blendTexture = (base, layer, opacity, blendMode, target) => {
        if (!base || !layer || !target) {
          return false;
        }
        const blendMaterial = this.textureAirbrushLayerBlendCompositeMaterial(blendMode, opacity);
        blendMaterial.uniforms.baseTexture.value = base;
        blendMaterial.uniforms.layerTexture.value = layer;
        this.textureAirbrushGpuCopyMesh.material = blendMaterial;
        this.renderer.setRenderTarget(target);
        this.textureAirbrushWithRawTextureMatrix(base, () => {
          this.textureAirbrushWithRawTextureMatrix(layer, () => {
            this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
          });
        });
        return true;
      };
      this.renderer.autoClear = false;
      this.renderer.setClearColor?.(0x000000, 0);
      const initialTarget = displayedTarget === composite.target ? ensureScratchTarget() : composite.target;
      this.renderer.setRenderTarget(initialTarget);
      this.renderer.clear(true, true, true);
      renderTexture(baseTexture, 1, initialTarget);
      let currentTarget = initialTarget;
      for (const layer of stack.layers || []) {
        if (!layer?.visible || !layer.canvas) {
          continue;
        }
        const texture = layer.gpuTarget?.target?.texture
          || this.textureAirbrushCanvasTextureForLayerCanvas(layer, "gpuLayer", layer.canvas, sourceTexture);
        const blendMode = this.texturePaintLayerBlendMode?.(layer) || "normal";
        if (blendMode === "normal") {
          renderTexture(texture, layer.opacity ?? 1, currentTarget);
          continue;
        }
        const nextTarget = inactiveTargetFor(currentTarget);
        if (blendTexture(currentTarget.texture, texture, layer.opacity ?? 1, blendMode, nextTarget)) {
          currentTarget = nextTarget;
        }
      }
      if (currentTarget !== composite.target) {
        const previousCompositeTarget = composite.target;
        composite.target = currentTarget;
        if (composite.scratchTarget === currentTarget) {
          composite.scratchTarget = previousCompositeTarget;
        } else if (composite.stagingTarget === currentTarget) {
          composite.stagingTarget = previousCompositeTarget;
        } else if (!composite.scratchTarget || composite.scratchTarget === composite.target) {
          composite.scratchTarget = previousCompositeTarget;
        }
      }
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setClearColor?.(previousClearColor, previousClearAlpha);
      material.map = composite.target.texture;
      material.needsUpdate = true;
      return true;
    },

    flushTexturePaintLayerGpuTargetsToCanvases(options = {}) {
      const materials = [];
      const requestedMaterial = options.material || null;
      if (requestedMaterial) {
        materials.push(requestedMaterial);
      } else {
        for (const paintable of this.textureAirbrushPaintableMaterials?.() || []) {
          if (paintable.material && !materials.includes(paintable.material)) {
            materials.push(paintable.material);
          }
        }
      }
      let flushed = 0;
      for (const material of materials) {
        const stack = material?.userData?.texturePaintLayerStack;
        if (!stack?.layers?.length) {
          continue;
        }
        for (const layer of stack.layers) {
          const targetEntry = layer?.gpuTarget;
          if (!targetEntry?.target?.texture || !layer.canvas || !layer.context) {
            continue;
          }
          const editable = this.textureAirbrushCanvasFromRenderTarget?.(targetEntry);
          if (!editable?.canvas || !editable.context) {
            continue;
          }
          layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
          layer.context.drawImage(editable.canvas, 0, 0, layer.canvas.width, layer.canvas.height);
          const image = layer.context.getImageData?.(0, 0, layer.canvas.width, layer.canvas.height);
          if (image?.data) {
            let empty = true;
            for (let index = 3; index < image.data.length; index += 4) {
              if (image.data[index] !== 0) {
                empty = false;
                break;
              }
            }
            layer.isEmpty = empty;
            targetEntry.emptyTransparent = empty;
            if (empty) {
              targetEntry.paintRevision = 0;
            }
          }
          if (layer.gpuLayerTexture) {
            layer.gpuLayerTexture.needsUpdate = true;
          }
          flushed += 1;
        }
        if (options.composite !== false) {
          this.texturePaintCompositeMaterialLayerGpuTargets?.(material);
        }
      }
      if (flushed) {
        this.scheduleTexturePaintLayerPanelRender?.();
      }
      return flushed;
    },

    textureAirbrushCanvasFromRenderTarget(targetEntry) {
      const target = targetEntry?.target;
      if (!target || !this.renderer || typeof this.renderer.readRenderTargetPixels !== "function" || typeof document === "undefined") {
        return null;
      }
      const texture = target.texture;
      const width = Math.max(1, targetEntry.width || target.width || texture?.image?.width || 1);
      const height = Math.max(1, targetEntry.height || target.height || texture?.image?.height || 1);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }
      const buffer = new Uint8Array(width * height * 4);
      const previousTarget = typeof this.renderer.getRenderTarget === "function"
        ? this.renderer.getRenderTarget()
        : null;
      try {
        this.renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer);
      } finally {
        if (typeof this.renderer.setRenderTarget === "function") {
          this.renderer.setRenderTarget(previousTarget);
        }
      }
      const image = context.createImageData(width, height);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y += 1) {
        const sourceStart = (height - 1 - y) * rowBytes;
        const targetStart = y * rowBytes;
        image.data.set(buffer.subarray(sourceStart, sourceStart + rowBytes), targetStart);
      }
      context.putImageData(image, 0, 0);
      return { canvas, context, width, height };
    },

    flushTextureAirbrushGpuTargetsToCanvases(options = {}) {
      const paintables = this.textureAirbrushPaintableMaterials?.() || [];
      const seen = new Set();
      let flushed = 0;
      for (const paintable of paintables) {
        const material = paintable.material;
        const targetEntry = material?.userData?.textureAirbrushGpuTarget;
        if (!material || !targetEntry?.target?.texture || seen.has(material)) {
          continue;
        }
        if (
          options.mutatedOnly === true
          && Math.max(0, Math.floor(Number(targetEntry.paintRevision) || 0)) <= 0
        ) {
          continue;
        }
        seen.add(material);
        const editable = this.textureAirbrushCanvasFromRenderTarget?.(targetEntry);
        if (!editable?.canvas || !editable.context) {
          continue;
        }
        const previousTexture = material.userData?.clonePaintTexture;
        const texture = new THREE.CanvasTexture(editable.canvas);
        texture.name = `${targetEntry.target.texture.name || material.map?.name || "texture"} airbrush bake`;
        this.textureAirbrushCopyTextureRenderSettings?.(texture, targetEntry.target.texture);
        texture.needsUpdate = true;
        material.map = texture;
        material.needsUpdate = true;
        material.userData ||= {};
        material.userData.clonePaintCanvas = editable.canvas;
        material.userData.clonePaintContext = editable.context;
        material.userData.clonePaintTexture = texture;
        material.userData.clonePaintTextureScale = targetEntry.sourceTexture?.userData?.clonePaintTextureScale || 1;
        this.texturePaintSyncBackgroundFromEditable?.(material, {
          canvas: editable.canvas,
          context: editable.context,
          texture
        }, { renderPanel: false });
        delete material.userData.textureAirbrushGpuTarget;
        if (previousTexture && previousTexture !== texture && previousTexture !== material.userData.clonePaintOriginalMap) {
          previousTexture.dispose?.();
        }
        this.disposeTexturePaintGpuPrewarmSnapshot?.(targetEntry);
        targetEntry.target.dispose?.();
        flushed += 1;
      }
      if (!flushed) {
        return 0;
      }
      this.textureAirbrushGpuProxies?.clear?.();
      this.updateClonePaintPreviews?.();
      return flushed;
    },

    textureAirbrushGpuProxyForRecord(record, materialIndex, material) {
      const key = `${record.geometry?.uuid || "geometry"}:${materialIndex}`;
      this.textureAirbrushGpuProxies ||= new Map();
      let entry = this.textureAirbrushGpuProxies.get(key);
      const shaderMaterial = this.textureAirbrushBrushShaderMaterial();
      const sourceMaterials = Array.isArray(record.object.material)
        ? record.object.material
        : [record.object.material];
      const paintMaterials = sourceMaterials.map((_, index) => (
        index === materialIndex ? shaderMaterial : this.textureAirbrushNoopMaterial()
      ));
      if (!entry) {
        const proxy = record.object.isSkinnedMesh
          ? new THREE.SkinnedMesh(record.geometry, paintMaterials)
          : new THREE.Mesh(record.geometry, paintMaterials);
        proxy.frustumCulled = false;
        proxy.matrixAutoUpdate = false;
        if (proxy.isSkinnedMesh && record.object.skeleton) {
          proxy.bind(record.object.skeleton, record.object.bindMatrix);
          proxy.bindMatrixInverse.copy(record.object.bindMatrixInverse);
        }
        const scene = new THREE.Scene();
        scene.add(proxy);
        entry = { proxy, scene };
        this.textureAirbrushGpuProxies.set(key, entry);
      } else {
        entry.proxy.material = paintMaterials;
      }
      entry.proxy.matrixWorld.copy(record.object.matrixWorld);
      entry.proxy.matrix.copy(record.object.matrix);
      entry.proxy.visible = true;
      return entry;
    },

    textureAirbrushPrecompileBrushProxyScene(proxyEntry = null) {
      if (!proxyEntry?.scene || !this.renderer) {
        return false;
      }
      if (proxyEntry.brushShaderPrecompiled === true) {
        return false;
      }
      if (!this.textureAirbrushGpuCopyCamera) {
        this.textureAirbrushEnsureCopyScene?.();
      }
      const camera = this.textureAirbrushGpuCopyCamera || this.camera || null;
      if (!camera) {
        return false;
      }
      if (typeof this.renderer.compile !== "function" && typeof this.renderer.compileAsync !== "function") {
        return false;
      }
      try {
        this.renderer.compile?.(proxyEntry.scene, camera);
        proxyEntry.brushShaderPrecompiled = true;
        const compileAsync = this.renderer.compileAsync?.(proxyEntry.scene, camera);
        if (compileAsync && typeof compileAsync.catch === "function") {
          compileAsync.catch(() => {});
        }
        return true;
      } catch (error) {
        delete proxyEntry.brushShaderPrecompiled;
        return false;
      }
    },

    textureAirbrushPrewarmUvBleedOffsets(targetEntry = null, radiusPixels = null) {
      if (!targetEntry?.target?.texture || typeof this.textureAirbrushGpuUvBleedOffsets !== "function") {
        return false;
      }
      const usesDefaultBleedOffsets = this.textureAirbrushGpuUvBleedOffsets
        === BirdWeightEditor.prototype.textureAirbrushGpuUvBleedOffsets;
      if (usesDefaultBleedOffsets && typeof THREE.Vector2 !== "function") {
        return false;
      }
      const baseRadius = Math.max(
        1,
        Number(radiusPixels)
          || Number(this.textureAirbrushStrokeBrushState?.radiusPixels)
          || Number(this.textureBrushRadiusScreenPixels?.())
          || 8
      );
      const radii = [
        baseRadius,
        Math.max(10, baseRadius),
        Math.max(17, baseRadius)
      ];
      for (const radius of radii) {
        this.textureAirbrushGpuUvBleedOffsets(targetEntry, radius);
      }
      return true;
    },
  });
}
