import { installTextureAirbrushBrushSettingsMethods } from "./brush-settings.js";
import { installTextureAirbrushCloneReplayMethods } from "./clone-replay.js";
import { installTextureAirbrushNeighborPaintMethods } from "./neighbor.js";
import { installTextureAirbrushPressureMethods } from "./pressure.js";
import { installTextureAirbrushPointerMethods } from "./pointer.js";
import { installTextureAirbrushProjectedPaintMethods } from "./projected-paint.js";
import { installTextureAirbrushScreenStrokeMethods } from "./screen-strokes.js";
import { installTextureAirbrushTexturePickingMethods } from "./texture-picking.js";
import { installTextureAirbrushUvBrushMethods } from "./uv-brush.js";
import { installTextureAirbrushVisibleRegionGeometryMethods } from "./visible-region-geometry.js";
import { installTextureAirbrushVisibleRegionMethods } from "./visible-region.js";
import { installTextureAirbrushWebGlBackendMethods } from "./webgl-backend.js";

export function installTextureAirbrushMethods(BirdWeightEditor, deps) {
  // Painting module note:
  // WebGPU is the primary brush direction. The WebGL backend remains installed only
  // as compatibility fallback while the remaining legacy render-target code is ported.
  // Live airbrush must still use a camera-visible/frontmost mask in every backend.

  installTextureAirbrushPressureMethods(BirdWeightEditor);
  installTextureAirbrushPointerMethods(BirdWeightEditor);
  installTextureAirbrushNeighborPaintMethods(BirdWeightEditor);
  installTextureAirbrushScreenStrokeMethods(BirdWeightEditor);
  installTextureAirbrushBrushSettingsMethods(BirdWeightEditor, deps);
  installTextureAirbrushCloneReplayMethods(BirdWeightEditor, deps);
  installTextureAirbrushVisibleRegionGeometryMethods(BirdWeightEditor, deps);
  installTextureAirbrushVisibleRegionMethods(BirdWeightEditor, deps);
  installTextureAirbrushTexturePickingMethods(BirdWeightEditor, deps);
  installTextureAirbrushUvBrushMethods(BirdWeightEditor, deps);
  installTextureAirbrushWebGlBackendMethods(BirdWeightEditor, deps);
  installTextureAirbrushProjectedPaintMethods(BirdWeightEditor);
}
