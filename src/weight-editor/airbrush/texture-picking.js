import {
  byteHex,
  linearByteToSrgbByte
} from "./math.js";

export function installTextureAirbrushTexturePickingMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    applyPickedTextureColor(sample) {
      if (!sample) {
        return false;
      }
      if (Number.isFinite(sample.a) && sample.a <= 8) {
        return false;
      }
      const hex = `#${byteHex(sample.r)}${byteHex(sample.g)}${byteHex(sample.b)}`;
      if (this.texturePaintColor) {
        this.texturePaintColor.value = hex;
      }
      this.setStatus(`Picked ${hex}`);
      return true;
    },

    pickTextureColorNear(record, hit) {
      const material = this.clonePaintMaterialForHit?.(record, hit);
      const hitUv = hit?.uv;
      if (!material || !hitUv) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return false;
      }

      const renderedSample = this.pickTextureGpuSampleColor?.(material.map, hitUv);
      if (this.applyPickedTextureColor?.(renderedSample)) {
        return true;
      }

      const gpuSample = this.pickTextureGpuTargetColorNear?.(material, hitUv);
      if (this.applyPickedTextureColor?.(gpuSample)) {
        return true;
      }

      const editable = this.editableClonePaintTexture?.(material);
      if (!editable) {
        this.setStatus("Pick needs an editable texture under the cursor");
        return false;
      }
      const { canvas, context, texture } = editable;
      const pixel = this.clonePaintPixelFromUv(hitUv, canvas, texture);
      const data = context.getImageData(pixel.x, pixel.y, 1, 1).data;
      return this.applyPickedTextureColor?.({ r: data[0], g: data[1], b: data[2], a: data[3] }) || false;
    },

    textureAirbrushRenderTargetPixelFromUv(uv, targetEntry) {
      const texture = targetEntry?.target?.texture;
      const width = Math.max(1, targetEntry?.width || targetEntry?.target?.width || texture?.image?.width || 1);
      const height = Math.max(1, targetEntry?.height || targetEntry?.target?.height || texture?.image?.height || 1);
      const mapped = this.clonePaintTextureUv?.(uv, texture) || uv?.clone?.();
      if (!mapped) {
        return null;
      }
      const u = this.clonePaintWrapUvCoordinate
        ? this.clonePaintWrapUvCoordinate(mapped.x, texture?.wrapS)
        : Math.max(0, Math.min(1, mapped.x));
      const v = this.clonePaintWrapUvCoordinate
        ? this.clonePaintWrapUvCoordinate(mapped.y, texture?.wrapT)
        : Math.max(0, Math.min(1, mapped.y));
      return {
        x: Math.max(0, Math.min(width - 1, Math.round(u * (width - 1)))),
        // WebGL readPixels uses the render target's lower-left origin. Do not apply canvas/image flipY here.
        y: Math.max(0, Math.min(height - 1, Math.round(v * (height - 1)))),
        width,
        height
      };
    },

    pickTextureGpuSampleMaterial() {
      if (!this.texturePickerGpuSampleMaterial) {
        this.texturePickerGpuSampleMaterial = new THREE.ShaderMaterial({
          depthTest: false,
          depthWrite: false,
          uniforms: {
            sourceTexture: { value: null },
            sampleUv: { value: new THREE.Vector2() }
          },
          vertexShader: `
            varying vec2 vUv;

            void main() {
              vUv = uv;
              gl_Position = vec4(position.xy, 0.0, 1.0);
            }
          `,
          fragmentShader: `
            uniform sampler2D sourceTexture;
            uniform vec2 sampleUv;

            void main() {
              gl_FragColor = texture2D(sourceTexture, sampleUv);
            }
          `
        });
      }
      return this.texturePickerGpuSampleMaterial;
    },

    pickTextureGpuSampleTarget() {
      if (this.texturePickerGpuSampleTarget) {
        return this.texturePickerGpuSampleTarget;
      }
      this.texturePickerGpuSampleTarget = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false
      });
      this.texturePickerGpuSampleTarget.texture.name = "texture picker sample";
      return this.texturePickerGpuSampleTarget;
    },

    pickTextureGpuSampleColor(texture, uv) {
      if (!this.renderer || !texture || !uv) {
        return null;
      }
      this.textureAirbrushEnsureCopyScene?.();
      const target = this.pickTextureGpuSampleTarget?.();
      const material = this.pickTextureGpuSampleMaterial?.();
      if (!target || !material || !this.textureAirbrushGpuCopyMesh || !this.textureAirbrushGpuCopyScene || !this.textureAirbrushGpuCopyCamera) {
        return null;
      }
      const mapped = this.clonePaintTextureUv?.(uv, texture) || uv.clone?.() || uv;
      const sampleUv = new THREE.Vector2(
        this.clonePaintWrapUvCoordinate
          ? this.clonePaintWrapUvCoordinate(mapped.x, texture.wrapS)
          : Math.max(0, Math.min(1, mapped.x)),
        this.clonePaintWrapUvCoordinate
          ? this.clonePaintWrapUvCoordinate(mapped.y, texture.wrapT)
          : Math.max(0, Math.min(1, mapped.y))
      );
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      const previousMaterial = this.textureAirbrushGpuCopyMesh.material;
      const buffer = new Uint8Array(4);
      material.uniforms.sourceTexture.value = texture;
      material.uniforms.sampleUv.value.copy(sampleUv);
      this.textureAirbrushGpuCopyMesh.material = material;
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = true;
      this.renderer.clear(true, true, true);
      this.renderer.render(this.textureAirbrushGpuCopyScene, this.textureAirbrushGpuCopyCamera);
      this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, buffer);
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.textureAirbrushGpuCopyMesh.material = previousMaterial;
      if (texture.colorSpace === THREE.SRGBColorSpace) {
        return {
          r: linearByteToSrgbByte(buffer[0]),
          g: linearByteToSrgbByte(buffer[1]),
          b: linearByteToSrgbByte(buffer[2]),
          a: buffer[3]
        };
      }
      return { r: buffer[0], g: buffer[1], b: buffer[2], a: buffer[3] };
    },

    pickTextureGpuTargetColorNear(material, uv) {
      const entry = material?.userData?.textureAirbrushGpuTarget;
      const target = entry?.target;
      if (!entry || !target || !this.renderer || !uv) {
        return null;
      }
      const directSample = this.pickTextureGpuSampleColor?.(target.texture, uv);
      if (directSample) {
        return directSample;
      }
      const pixel = this.textureAirbrushRenderTargetPixelFromUv?.(uv, entry);
      if (!pixel) {
        return null;
      }
      const width = pixel.width;
      const height = pixel.height;
      const centerX = pixel.x;
      const centerY = pixel.y;
      const buffer = new Uint8Array(4);
      const samples = [];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = Math.max(0, Math.min(width - 1, centerX + dx));
          const y = Math.max(0, Math.min(height - 1, centerY + dy));
          this.renderer.readRenderTargetPixels(target, x, y, 1, 1, buffer);
          samples.push([buffer[0], buffer[1], buffer[2], buffer[3]]);
        }
      }
      const opaqueSamples = samples.filter((sample) => sample[3] > 8);
      const source = opaqueSamples.length ? opaqueSamples : samples;
      if (!source.length) {
        return null;
      }
      const average = source.reduce((sum, sample) => {
        sum.r += sample[0];
        sum.g += sample[1];
        sum.b += sample[2];
        return sum;
      }, { r: 0, g: 0, b: 0 });
      return {
        r: average.r / source.length,
        g: average.g / source.length,
        b: average.b / source.length
      };
    }
  });
}
