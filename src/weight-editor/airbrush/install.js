import { installTextureAirbrushBrushSettingsMethods } from "./brush-settings.js";
import { installTextureAirbrushCloneReplayMethods } from "./clone-replay.js";
import { installTextureAirbrushNeighborPaintMethods } from "./neighbor.js?v=layer-undo-fix-20260621a";
import { installTextureAirbrushPressureMethods } from "./pressure.js";
import { installTextureAirbrushPointerMethods } from "./pointer.js?v=layer-hover-preserve-display-20260621a";
import { installTextureAirbrushProjectedPaintMethods } from "./projected-paint.js?v=layer-undo-fix-20260621a";
import { installTextureAirbrushScreenStrokeMethods } from "./screen-strokes.js?v=layer-undo-fix-20260621a";
import { installTextureAirbrushTexturePickingMethods } from "./texture-picking.js";
import { installTextureAirbrushUvBrushMethods } from "./uv-brush.js?v=stroke-opacity-cap-20260620c";
import { installTextureAirbrushVisibleRegionGeometryMethods } from "./visible-region-geometry.js";
import { installTextureAirbrushVisibleRegionMethods } from "./visible-region.js";
import { installTextureAirbrushWebGlBackendMethods } from "./webgl-backend.js?v=layer-undo-fix-20260621a";

export function installTextureAirbrushMethods(BirdWeightEditor, deps) {
  // Painting module note:
  // The current airbrush is a WebGL live-bake brush: each stroke projects screen-space
  // brush segments into UV texture render targets. A Photoshop-like brush feel likely
  // needs a larger WebGPU brush-engine pass instead of another UI preview layer. The
  // future direction is a shared stroke buffer, one native WebGPU brush kernel for both
  // preview and bake, tiled texture updates, and identical brush math for the screen
  // preview and final UV texture result. The WebGPU backend has to stay behind an
  // explicit resolver because this app currently displays painted textures through a
  // WebGL renderer, and native WebGPU textures cannot be shared directly with WebGL.
  // We tried a separate 2D overlay preview, but it did not agree visually with the bake
  // because screen pixels, UV texels, seams, filtering, depth, and falloff all diverged.

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
