export function installTextureAirbrushVisibleRegionGeometryMethods(BirdWeightEditor, deps) {
  const { THREE } = deps;

  Object.assign(BirdWeightEditor.prototype, {
    texturePaintVisibleRegionTriangles(record, materialIndex, canvas, texture, options = {}) {
      const referenceMapped = options.referenceUv
        ? this.clonePaintTextureUv(options.referenceUv, texture)
        : null;
      const triangles = [];
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (
          !overlay?.visible
          || overlay.userData?.cloneSpotlightKind !== "target"
          || overlay.userData?.cloneSpotlightRecord !== record
        ) {
          continue;
        }
        const geometry = overlay.geometry;
        const uv = geometry?.attributes?.uv;
        const position = geometry?.attributes?.position;
        if (!uv || !position) {
          continue;
        }
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          const start = triangle * 3;
          const faceMaterialIndex = this.texturePaintOverlayMaterialIndex?.(geometry, start) ?? 0;
          if (Number.isInteger(materialIndex) && faceMaterialIndex !== materialIndex) {
            continue;
          }
          const pixels = [0, 1, 2].map((offset) => {
            const mapped = this.clonePaintTextureUv(
              new THREE.Vector2(uv.getX(start + offset), uv.getY(start + offset)),
              texture
            );
            if (referenceMapped) {
              mapped.x = this.clonePaintUnwrapTextureCoordinate(mapped.x, referenceMapped.x, texture?.wrapS);
              mapped.y = this.clonePaintUnwrapTextureCoordinate(mapped.y, referenceMapped.y, texture?.wrapT);
            }
            return this.clonePaintPixelFromMappedTextureUv(mapped, canvas, texture, {
              wrap: !referenceMapped
            });
          });
          if (pixels.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
            triangles.push({
              face: { a: start, b: start + 1, c: start + 2, materialIndex: faceMaterialIndex },
              pixels
            });
          }
        }
      }
      return triangles;
    },

    texturePaintVisibleRegionMaterialIndexes(record) {
      const materialIndexes = new Set();
      for (const overlay of this.cloneSpotlightOverlays || []) {
        if (
          !overlay?.visible
          || overlay.userData?.cloneSpotlightKind !== "target"
          || overlay.userData?.cloneSpotlightRecord !== record
        ) {
          continue;
        }
        const geometry = overlay.geometry;
        const position = geometry?.attributes?.position;
        if (!position) {
          continue;
        }
        const triangleCount = Math.floor(position.count / 3);
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          materialIndexes.add(this.texturePaintOverlayMaterialIndex?.(geometry, triangle * 3) ?? 0);
        }
      }
      return [...materialIndexes].sort((left, right) => left - right);
    }
  });
}
