import { installTextureAirbrushBrushSettingsMethods } from "./brush-settings.js";
import { installTextureAirbrushCloneReplayMethods } from "./clone-replay.js";
import { installTextureAirbrushNeighborPaintMethods } from "./neighbor.js";
import { installTextureAirbrushPressureMethods } from "./pressure.js";
import { installTextureAirbrushPointerMethods } from "./pointer.js";
import { installTextureAirbrushScreenStrokeMethods } from "./screen-strokes.js";
import { installTextureAirbrushTexturePickingMethods } from "./texture-picking.js";
import { installTextureAirbrushUvBrushMethods } from "./uv-brush.js";
import { installTextureAirbrushVisibleSurfacePaintMethods } from "./visible-surface-paint.js";
import { installTextureAirbrushVisibleRegionGeometryMethods } from "./visible-region-geometry.js";
import { installTextureAirbrushVisibleRegionMethods } from "./visible-region.js";

export function installTextureAirbrushMethods(BirdWeightEditor, deps) {
  // Painting module note: live airbrush is WebGPU-only. A camera-facing normal
  // can paint; a back-facing normal cannot. Do not install legacy projection
  // backends as hidden fallbacks.

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
  installTextureAirbrushVisibleSurfacePaintMethods(BirdWeightEditor);
}
