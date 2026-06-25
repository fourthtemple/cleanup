import { installTextureAirbrushBrushSettingsMethods } from "./brush-settings.js";
import { installTextureAirbrushCloneReplayMethods } from "./clone-replay.js";
import { installTextureAirbrushNeighborPaintMethods } from "./neighbor.js?v=visible-side-facing-20260623a";
import { installTextureAirbrushPressureMethods } from "./pressure.js?v=pressure-cleanup-20260623a";
import { installTextureAirbrushPointerMethods } from "./pointer.js?v=clean-preview-cursor-20260622a";
import { installTextureAirbrushProjectedPaintMethods } from "./projected-paint.js?v=post-orbit-solid-20260624a";
import { installTextureAirbrushScreenStrokeMethods } from "./screen-strokes.js?v=post-orbit-solid-20260624a";
import { installTextureAirbrushTexturePickingMethods } from "./texture-picking.js";
import { installTextureAirbrushUvBrushMethods } from "./uv-brush.js?v=visible-side-facing-20260623a";
import { installTextureAirbrushVisibleRegionGeometryMethods } from "./visible-region-geometry.js";
import { installTextureAirbrushVisibleRegionMethods } from "./visible-region.js";
import { installTextureAirbrushWebGlBackendMethods } from "./webgl-backend.js?v=visible-edge-strict-fade-20260625d";

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
