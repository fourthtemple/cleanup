# Airbrush WebGPU Strategy

Fourth Temple Cleanup currently uses a WebGL live-bake airbrush. Pointer strokes are projected from screen space into UV render targets, then the painted render target becomes the material texture. This is already GPU-assisted, but it is still WebGL and still carries WebGL limits around stalls, readback, and shader/render-target coupling.

## Goal

Build a real WebGPU airbrush that feels like a pressure-sensitive paint tool:

- smooth continuous strokes with no first-stroke stall
- identical brush math for preview and final texture bake
- pressure-sensitive radius, opacity, hardness, and scatter
- dirty/tiled texture updates instead of repeated full texture work
- undo snapshots that do not force large synchronous readbacks during painting
- preserved FBX/GLB export behavior
- WebGL/CPU fallback for browsers that cannot run native WebGPU

## Current Constraint

The viewer is still a `THREE.WebGLRenderer`. Native WebGPU textures cannot be shared directly with a WebGL renderer. A WebGPU brush that writes to a WebGPU texture would still need a sync/copy step before the WebGL viewer can display it.

Because of that, the WebGPU airbrush cannot be a small replacement for the existing WebGL shader. The brush backend and the viewer renderer have to be treated as separate migration steps.

## Strategy

1. Keep the current WebGL brush as the production backend.

2. Route all brush input through a backend-neutral brush options layer.
   This layer owns pressure, radius, opacity, hardness, scatter, color, and stroke segments. WebGL, CPU fallback, and future WebGPU should receive the same effective values.

3. Keep the WebGPU backend behind an explicit resolver.
   The resolver should only select native WebGPU when the browser supports WebGPU and the viewer is actually using a native WebGPU renderer/backend. Otherwise it should fall back to WebGL or CPU.

4. Build a WebGPU renderer spike behind a flag.
   The spike must verify model loading, skinned animation, orbit controls, transform controls, overlays, selection, texture picking, render-target equivalents, export readback, and tutorial playback.

5. Move the brush kernel to WGSL after the renderer spike is viable.
   The kernel should consume stroke segments from a GPU buffer, paint into texture tiles/storage textures, and use the same falloff math as the preview path.

6. Add tiled undo/readback.
   Undo should snapshot only dirty tiles or keep GPU-side texture versions during a stroke. Export can pay the readback cost, but live painting should not.

7. Remove the old 2D overlay preview path once WebGPU preview and bake match.
   The overlay preview was fast, but it could not match the real bake because screen pixels, UV texels, seams, filtering, depth, and falloff diverged.

## Milestones

### Milestone 1: Backend Boundary

Status: started.

- Add WebGPU capability and backend resolver.
- Keep WebGL as default.
- Add tests so normal users stay on WebGL until native WebGPU is truly ready.
- Add pressure-sensitive brush options before backend selection.

### Milestone 2: WebGPU Renderer Spike

- Add an opt-in `webgpu-renderer` flag.
- Load the viewer with `THREE.WebGPURenderer`.
- Confirm the app can render animated skinned FBX/GLB assets.
- Identify every WebGL-only helper that needs a WebGPU equivalent.

### Milestone 3: Shared Brush Math

Status: started.

- Move airbrush falloff into a small spec shared by JavaScript tests and WGSL.
- Test pressure scaling for radius, opacity, hardness, and scatter.
- Make preview and bake use the same effective brush options.

Current implementation note: `src/weight-editor/airbrush/webgpu-kernel.js` now defines the first WebGPU brush-kernel contract: sanitized brush parameters, dispatch sizing, and WGSL compute source for texture painting. `src/weight-editor/airbrush/webgpu-plan.js` packs the matching uniform/stroke buffers and WebGPU descriptors. `src/weight-editor/airbrush/webgpu-dispatch.js` can allocate native WebGPU resources and submit the compute pass when a native device and source pixels are available.

### Milestone 4: WebGPU Paint Target

Status: started.

- Allocate WebGPU paint textures or storage textures.
- Upload source texture data once.
- Paint stroke segments directly into dirty tiles.
- Avoid per-move CPU readback.
- Keep export readback explicit and deferred.

Current implementation note: WebGPU descriptor constants, usage flags, bind-group layout entries, texture descriptors, buffer descriptors, and readback layout helpers live in `src/weight-editor/airbrush/webgpu-descriptors.js`. `src/weight-editor/airbrush/webgpu-plan.js` assembles those descriptors with brush-specific dirty bounds, uniform packing, stroke packing, and dispatch sizing. The WebGPU resource helper in `src/weight-editor/airbrush/webgpu-resources.js` creates source/output textures, uniform/stroke buffers, readback buffers, bind group layout, bind group, shader module, and compute pipeline. Reused paint resources now also reuse compatible readback buffers, avoiding a fresh GPU buffer allocation on every live paint once the dirty rectangle layout stabilizes. `src/weight-editor/airbrush/webgpu-dispatch.js` is focused on command encoding/submission: compute pass dispatch, optional dirty readback copy, and optional output-to-source persistence. Mapped row unpacking lives in `src/weight-editor/airbrush/webgpu-readback.js` so readback behavior can be tested without the dispatch module owning CPU pixel layout details. Runtime status and the console self-test helper live in `src/weight-editor/airbrush/webgpu-diagnostics.js`. `src/weight-editor/airbrush/webgpu-canvas.js` bridges this to editable texture canvases and records opt-in workload stats on successful editable WebGPU paints, including dirty bounds, source upload bytes, readback bytes, applied bytes, resource reuse, readback-buffer reuse, apply-ImageData reuse, and coarse prepare/dispatch/readback/apply timings. Source pixel snapshots, dirty subrect application, and reusable `ImageData` handling live in `src/weight-editor/airbrush/webgpu-editable.js`; repeated live paints can update the same CPU-side apply buffer instead of allocating a new one. `src/weight-editor/airbrush/webgpu-stroke.js` converts direct mesh hits into texture-space stroke segments, while `src/weight-editor/airbrush/webgpu-candidates.js` discovers direct and projected editable paint candidates for the live WebGPU path. `src/weight-editor/airbrush/projection.js` owns the shared screen-space stroke probes and front-surface depth window used by the WebGL, WebGPU, and CPU fallback projection paths. `src/weight-editor/airbrush/math.js` owns the shared brush falloff contract: halo scatter scale, edge exponent terms, and alpha discard threshold are used by JavaScript helpers plus generated GLSL/WGSL shader sources. `src/weight-editor/airbrush/webgpu-resolver.js` owns opt-in capability selection, and `src/weight-editor/airbrush/webgpu-live.js` owns live stroke queuing and batching; undo snapshots are captured once per editable texture/canvas identity in the queued WebGPU batch, and oversized stroke batches are split at the shared shader segment capacity so CPU-side dirty bounds match what the WGSL kernel can actually paint. The production WebGL shader/material setup lives in `src/weight-editor/airbrush/webgl-materials.js`, the WebGL projected brush pass lives in `src/weight-editor/airbrush/webgl-project.js`, and `src/weight-editor/airbrush/webgl-backend.js` is focused on targets, depth, copy scenes, and proxies. Texture color picking and one-pixel WebGL sampling live in `src/weight-editor/airbrush/texture-picking.js`. Visible-region triangle/material-index lookup lives in `src/weight-editor/airbrush/visible-region-geometry.js`. The high-level projected paint orchestration and CPU fallback live in `src/weight-editor/airbrush/projected-paint.js`, region-specific projected cleanup lives in `src/weight-editor/airbrush/projected-region.js`, legacy UV-near/full-region brushing lives in `src/weight-editor/airbrush/uv-near.js`, live stroke queueing lives in `src/weight-editor/airbrush/screen-strokes.js`, the temporary screen overlay renderer lives in `src/weight-editor/airbrush/screen-overlay.js`, and `src/weight-editor/airbrush/install.js` composes the module installers. Projected region fallback now captures one undo snapshot per editable material state instead of once per sampled ray hit. The WebGPU paint plan computes dirty paint bounds from the stroke batch, dispatches only those bounds, copies only that dirty rectangle back, and applies the returned subrect at its canvas origin. Editable texture WebGPU resources are cached per texture: source/output textures, pipeline, bind group, and buffers are reused across strokes, source pixels upload once, and each compute result is copied back into the cached source texture so the next stroke starts from GPU-resident paint state. The remaining application integration is tightening projected coverage to match the current WebGL depth-tested brush exactly and minimizing readback further.

### Milestone 5: Production Switch

- Prefer native WebGPU when available and tested.
- Fall back to WebGL shader brush.
- Fall back to CPU only when GPU paths fail.

## Non-Goals For The First Pass

- No immediate global renderer replacement in production.
- No separate fake 2D paint layer as the primary preview.
- No WebGPU readback on every pointer move.
- No feature that makes export worse or breaks the current WebGL airbrush.

## Validation Status

Command-level coverage currently verifies the backend resolver, pressure-aware brush options, shared JavaScript/WGSL brush math, WebGPU descriptor packing, dirty-bounds planning, resource reuse, readback row unpacking, editable-canvas application, live queue batching, stroke batch splitting, projected candidate discovery, and WebGL fallback behavior.

Native browser/runtime validation is still required before making WebGPU the default. The repeatable smoke gate is:

```sh
npm run validate:webgpu-airbrush
```

That command starts a local Cleanup dev server, launches Chrome with `?webgpu-renderer=1&webgpu-airbrush=1`, inspects `window.modelCleanupWebGpuStatus()`, runs `await window.modelCleanupWebGpuSelfTest()`, loads the built-in `humanoid-cat-walking.fbx` demo, prewarms the editable material texture, paints it through the WebGPU airbrush path, and fails unless native WebGPU, the native WebGPU renderer backend, the WebGPU airbrush backend, non-empty compute readback, asset loading, editable texture prewarm, first-stroke resource reuse, editable texture painting, and dirty-region readback are all confirmed.

The current prewarm path is specifically intended to remove the first-contact pen/tablet hitch: selecting or hovering the airbrush can upload the editable texture source into the WebGPU cache before the pointer is pressed. The first painted stroke should then report `sourceUploaded: false`, `sourceBytes: 0`, and `reusedResources: true` in `textureAirbrushLastWebGpuPaintStats`.

The remaining proof points before turning WebGPU on by default are:

- launch the app with `?webgpu-renderer=1&webgpu-airbrush=1` in a browser with native WebGPU enabled
- inspect `window.modelCleanupWebGpuStatus()` or `window.modelCleanupEditor.textureAirbrushWebGpuRuntimeStatus()` and confirm `nativeWebGpuAvailable`, `rendererState.isNativeWebGpuBackend`, `deviceReady`, and `airbrushReady` are all true
- run `await window.modelCleanupWebGpuSelfTest()` and confirm it returns `{ ok: true, status: "ok" }` with a non-zero `paintedPixels` count
- verify the renderer backend is native WebGPU, not a WebGL fallback
- load a skinned animated FBX/GLB asset
- paint with pressure-enabled airbrush settings and inspect the recorded WebGPU paint stats
- confirm dirty-region readback/apply is visually correct on texture seams and projected front-surface strokes
- confirm export still receives the final painted texture data
