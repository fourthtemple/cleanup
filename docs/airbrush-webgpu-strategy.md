# Airbrush WebGPU Strategy

Fourth Temple Cleanup is moving its live-bake airbrush to WebGPU. Pointer strokes are projected from screen space into UV texture space, then WebGPU compute paints dirty texture regions and applies the result back to the editable texture data used for export.

## Goal

Build a real WebGPU airbrush that feels like a pressure-sensitive paint tool:

- smooth continuous strokes with no first-stroke stall
- identical brush math for preview and final texture bake
- pressure-sensitive radius, opacity, hardness, and scatter
- dirty/tiled texture updates instead of repeated full texture work
- undo snapshots that do not force large synchronous readbacks during painting
- preserved FBX/GLB export behavior
- WebGPU-only live paint, with no WebGL or CPU live-paint fallback

## Current Constraint

The viewer now requires `THREE.WebGPURenderer` with a native WebGPU backend for live airbrush painting. The legacy WebGL projection/backend modules have been retired from the default install path; remaining migration work is keeping renderer setup, live UV visibility masks, layer compositing, picking, readback, undo, and export aligned around the WebGPU texture pipeline.

## Strategy

1. Prefer the native WebGPU renderer and WebGPU airbrush backend when the device and visibility mask are ready.

2. Route all brush input through a backend-neutral brush options layer.
   This layer owns pressure, radius, opacity, hardness, scatter, color, and stroke segments. The WebGPU path should receive the same effective values the UI shows.

3. Keep backend selection behind an explicit resolver.
   The resolver should select native WebGPU when the browser supports WebGPU, the viewer is using a native WebGPU renderer/backend, and live projected paint has a camera-facing observability mask. Otherwise it should report no usable paint backend; live cursor paint must not select WebGL or CPU.

4. Keep replacing any remaining legacy render-target assumptions with WebGPU equivalents.
   The migration must verify model loading, skinned animation, orbit controls, transform controls, overlays, selection, texture picking, export readback, and tutorial playback without reinstalling WebGL paint backends.

5. Move the brush kernel to WGSL after the renderer spike is viable.
   The kernel should consume stroke segments from a GPU buffer, paint into texture tiles/storage textures, and use the same falloff math as the preview path.

6. Add tiled undo/readback.
   Undo should snapshot only dirty tiles or keep GPU-side texture versions during a stroke. Export can pay the readback cost, but live painting should not.

7. Remove the old 2D overlay preview path once WebGPU preview and bake match.
   The overlay preview was fast, but it could not match the real bake because screen pixels, UV texels, seams, filtering, depth, and falloff diverged.

## Milestones

### Milestone 1: Backend Boundary

Status: complete.

- Add WebGPU capability and backend resolver.
- Prefer WebGPU by default when native WebGPU is ready.
- Keep tests so browsers without native WebGPU stay on compatibility paths.
- Add pressure-sensitive brush options before backend selection.

### Milestone 2: WebGPU Renderer Spike

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

Current implementation note: WebGPU descriptor constants, usage flags, bind-group layout entries, texture descriptors, buffer descriptors, and readback layout helpers live in `src/weight-editor/airbrush/webgpu-descriptors.js`. `src/weight-editor/airbrush/webgpu-plan.js` assembles those descriptors with brush-specific dirty bounds, uniform packing, stroke packing, and dispatch sizing. The WebGPU resource helper in `src/weight-editor/airbrush/webgpu-resources.js` creates source/output textures, uniform/stroke buffers, readback buffers, bind group layout, bind group, shader module, and compute pipeline. Reused paint resources now also reuse compatible readback buffers, avoiding a fresh GPU buffer allocation on every live paint once the dirty rectangle layout stabilizes. `src/weight-editor/airbrush/webgpu-dispatch.js` is focused on command encoding/submission: compute pass dispatch, optional dirty readback copy, and optional output-to-source persistence. Mapped row unpacking lives in `src/weight-editor/airbrush/webgpu-readback.js` so readback behavior can be tested without the dispatch module owning CPU pixel layout details. Runtime status and the console self-test helper live in `src/weight-editor/airbrush/webgpu-diagnostics.js`. `src/weight-editor/airbrush/webgpu-canvas.js` bridges this to editable texture canvases and records opt-in workload stats on successful editable WebGPU paints, including dirty bounds, source upload bytes, readback bytes, applied bytes, resource reuse, readback-buffer reuse, apply-ImageData reuse, live external-texture display state, deferred live readback, and coarse prepare/dispatch/readback/apply timings. Source pixel snapshots, dirty subrect application, and reusable `ImageData` handling live in `src/weight-editor/airbrush/webgpu-editable.js`; repeated live paints can update the same CPU-side apply buffer instead of allocating a new one. `src/weight-editor/airbrush/webgpu-stroke.js` converts direct mesh hits into texture-space stroke segments, while `src/weight-editor/airbrush/webgpu-candidates.js` discovers direct and projected editable paint candidates for the live WebGPU path. `src/weight-editor/airbrush/webgpu-projection.js` builds the UV visibility mask used by live WebGPU painting, including a small capped edge bleed so sampled visible texels can soften adjacent unsampled UV texels without letting repeated strokes fill whole hidden islands. `src/weight-editor/airbrush/projection.js` owns the shared screen-space stroke probes and front-surface depth window used by projected WebGPU paint. `src/weight-editor/airbrush/math.js` owns the shared brush falloff contract: halo scatter scale, edge exponent terms, and alpha discard threshold are used by JavaScript helpers plus generated WGSL shader sources. `src/weight-editor/airbrush/webgpu-resolver.js` owns capability selection, and `src/weight-editor/airbrush/webgpu-live.js` owns live stroke queuing and batching; undo snapshots are captured once per editable texture/canvas identity in the queued WebGPU batch, far-apart UV islands are split into separate live batches so dirty rectangles stay local, and oversized stroke batches are split at the shared shader segment capacity so CPU-side dirty bounds match what the WGSL kernel can actually paint. Texture color picking samples editable pixels without WebGL render targets. Visible-region triangle/material-index lookup lives in `src/weight-editor/airbrush/visible-region-geometry.js`. The high-level projected paint orchestration and live CPU-backend rejection live in `src/weight-editor/airbrush/projected-paint.js`, region-specific projected cleanup lives in `src/weight-editor/airbrush/projected-region.js`, legacy UV-near/full-region brushing now rejects CPU fallback entrypoints, live stroke queueing lives in `src/weight-editor/airbrush/screen-strokes.js`, the temporary screen overlay renderer lives in `src/weight-editor/airbrush/screen-overlay.js`, and `src/weight-editor/airbrush/install.js` composes the WebGPU-only live-paint installer. The WebGPU paint plan computes dirty paint bounds from the stroke batch, dispatches only those bounds, copies only that dirty rectangle back, and applies the returned subrect at its canvas origin. Editable texture WebGPU resources are cached per texture: source/output textures, pipeline, bind group, and buffers are reused across strokes, source pixels upload once, and each compute result is copied back into the cached source texture so the next stroke starts from GPU-resident paint state. During live strokes, queued live dispatches do not wait for CPU `mapAsync`; the visible material temporarily swaps to a `THREE.ExternalTexture` backed by the compute `GPUTexture`, then deferred readback applies the dirty rectangle back to the existing canvas texture and restores the material map. The remaining application integration is minimizing readback and replacing any lingering render-target assumptions without restoring WebGL paint dependencies.

### Milestone 5: Production Switch

- Prefer native WebGPU when the renderer, device, and visible UV mask are ready.
- Report WebGPU unavailable; do not route live paint to WebGL or CPU.
- Report no usable live paint backend when GPU paths fail; do not fall back to CPU.

## Non-Goals For The First Pass

- No WebGL or CPU live-paint fallback.
- No separate fake 2D paint layer as the primary preview.
- No WebGPU readback on every pointer move.
- No feature that makes export worse while removing WebGL paint dependencies.

## Validation Status

Command-level coverage currently verifies the backend resolver, pressure-aware brush options, shared JavaScript/WGSL brush math, WebGPU descriptor packing, dirty-bounds planning, resource reuse, readback row unpacking, editable-canvas application, deferred live readback, live external texture swap, UV-local live queue batching, stroke batch splitting, projected candidate discovery, WebGPU visible-mask edge bleed, and WebGPU-only live-paint behavior.

The repeatable native browser/runtime smoke gate is:

```sh
npm run validate:webgpu-airbrush
```

That command starts a local Cleanup dev server, launches Chrome with a validation cache-bust query, inspects `window.modelCleanupWebGpuStatus()`, runs `await window.modelCleanupWebGpuSelfTest()`, loads the built-in `humanoid-cat-walking.fbx` demo, prewarms the editable material texture, paints it through the WebGPU airbrush path, and fails unless native WebGPU, the native WebGPU renderer backend, the WebGPU airbrush backend, non-empty compute readback, asset loading, editable texture prewarm, first-stroke resource reuse, editable texture painting, dirty-region readback, live external texture swapping, deferred live readback, dense fast live-stroke visibility sampling, UV-local fast-stroke dirty readback, browser rendering with the GPU texture and restored canvas texture, and deferred dirty-rectangle application are all confirmed.

The current prewarm path is specifically intended to remove the first-contact pen/tablet hitch: selecting or hovering the airbrush can upload the editable texture source into the WebGPU cache before the pointer is pressed. The first painted stroke should then report `sourceUploaded: false`, `sourceBytes: 0`, and `reusedResources: true` in `textureAirbrushLastWebGpuPaintStats`.

The remaining proof points before turning WebGPU on by default are:

- launch the app in a browser with native WebGPU enabled
- inspect `window.modelCleanupWebGpuStatus()` or `window.modelCleanupEditor.textureAirbrushWebGpuRuntimeStatus()` and confirm `nativeWebGpuAvailable`, `rendererState.isNativeWebGpuBackend`, `deviceReady`, and `airbrushReady` are all true
- run `await window.modelCleanupWebGpuSelfTest()` and confirm it returns `{ ok: true, status: "ok" }` with a non-zero `paintedPixels` count
- verify the renderer backend is native WebGPU
- load a skinned animated FBX/GLB asset
- paint with pressure-enabled airbrush settings and inspect the recorded WebGPU paint stats
- confirm dirty-region readback/apply is visually correct on texture seams and projected front-surface strokes
- confirm export still receives the final painted texture data
