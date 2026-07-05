export const TEXTURE_AIRBRUSH_WEBGPU_ENTRY_POINT = "textureAirbrushPaint";
export { textureAirbrushReadWebGpuPaintResult } from "./webgpu-readback.js";
import { textureAirbrushCreateWebGpuPaintResources as createWebGpuPaintResources } from "./webgpu-resources.js";
export { textureAirbrushCreateWebGpuPaintResources } from "./webgpu-resources.js";

export function textureAirbrushWebGpuDeviceFromRenderer(renderer = null) {
  const backend = renderer?.backend || null;
  if (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrush")
  ) {
    const root = window.document?.documentElement || null;
    if (root?.dataset) {
      root.dataset.textureAirbrushDebugRendererState = JSON.stringify({
        renderer: renderer?.constructor?.name || "",
        isWebGPURenderer: renderer?.isWebGPURenderer === true,
        backend: backend?.constructor?.name || "",
        isWebGPUBackend: backend?.isWebGPUBackend === true,
        hasDevice: Boolean(backend?.device),
        device: backend?.device?.constructor?.name || "",
        hasQueueSubmit: typeof backend?.device?.queue?.submit === "function",
        hasCreateComputePipeline: typeof backend?.device?.createComputePipeline === "function"
      });
    }
  }
  if (
    renderer?.isWebGPURenderer === true
    && backend?.isWebGPUBackend === true
    && backend?.device
  ) {
    return backend.device;
  }
  return null;
}

function useProjectedTriangleRenderPass(resources = null) {
  if (
    typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushDisableProjectedRenderPass")
  ) {
    return false;
  }
  const plan = resources?.plan;
  return plan?.screenProjectedCoverageActive === true
    && Math.floor(Number(plan?.params?.visibilityTriangleCount) || 0) > 0
    && Boolean(resources?.projectedRenderPipeline)
    && Boolean(resources?.projectedMaskPipeline)
    && Boolean(resources?.projectedMaskTexture)
    && Boolean(resources?.projectedRenderBindGroup);
}

function textureAirbrushDispatchCopyRegions(plan = null, projectedRenderPass = false) {
  const layout = plan?.buffers?.readback?.layout || null;
  if (projectedRenderPass) {
    return [{
      x: 0,
      y: 0,
      width: Math.max(1, Math.floor(Number(plan?.width) || 1)),
      height: Math.max(1, Math.floor(Number(plan?.height) || 1))
    }];
  }
  const compactRegions = plan?.compactPaintRegions === true && Array.isArray(plan.paintRegions)
    ? plan.paintRegions
    : [];
  if (compactRegions.length) {
    return compactRegions;
  }
  void projectedRenderPass;
  return layout ? [layout] : [];
}

function textureAirbrushProjectedRenderTriangleCount(plan = null) {
  return Math.max(0, Math.floor(Number(
    plan?.projectedRenderTriangleCount
    ?? plan?.params?.visibilityTriangleCount
  ) || 0));
}

export function textureAirbrushDispatchWebGpuPaint(device, resources, {
  readback = false,
  persistOutputToSource = false,
  commandEncoder: providedCommandEncoder = null,
  submit = true,
  label = "texture-airbrush"
} = {}) {
  const plan = resources?.plan;
  if (!device || !resources || !plan) {
    return null;
  }
  const debugErrorScope = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrush")
    && typeof device.pushErrorScope === "function"
    && typeof device.popErrorScope === "function";
  if (debugErrorScope) {
    try {
      device.pushErrorScope("validation");
    } catch {
      // Debug-only instrumentation; dispatch should continue.
    }
  }
  const commandEncoder = providedCommandEncoder || device.createCommandEncoder({
    label: `${label}-command-encoder`
  });
  const projectedRenderPass = useProjectedTriangleRenderPass(resources);
  if (
    resources.copySourceToStrokeBeforeDispatch === true
    && resources.sourceTexture
    && resources.strokeSourceTexture
    && typeof commandEncoder.copyTextureToTexture === "function"
  ) {
    const size = plan.textures?.strokeSource?.size || plan.textures?.source?.size || null;
    commandEncoder.copyTextureToTexture(
      { texture: resources.sourceTexture, origin: { x: 0, y: 0, z: 0 } },
      { texture: resources.strokeSourceTexture, origin: { x: 0, y: 0, z: 0 } },
      {
        width: Math.max(1, Math.floor(Number(size?.width) || plan.width || 1)),
        height: Math.max(1, Math.floor(Number(size?.height) || plan.height || 1)),
        depthOrArrayLayers: 1
      }
    );
    resources.copySourceToStrokeBeforeDispatch = false;
  }
  const dispatchCopyRegions = textureAirbrushDispatchCopyRegions(plan, projectedRenderPass);
  if (
    dispatchCopyRegions.length > 0
    && (
      projectedRenderPass
      || (plan.compactPaintRegions === true && plan.params?.compactPaintRegionTriangles)
    )
    && resources.sourceTexture
    && resources.outputTexture
    && typeof commandEncoder.copyTextureToTexture === "function"
  ) {
    for (const region of dispatchCopyRegions) {
      const x = Math.max(0, Math.floor(Number(region?.x) || 0));
      const y = Math.max(0, Math.floor(Number(region?.y) || 0));
      const width = Math.max(1, Math.floor(Number(region?.width) || 1));
      const height = Math.max(1, Math.floor(Number(region?.height) || 1));
      commandEncoder.copyTextureToTexture(
        { texture: resources.sourceTexture, origin: { x, y, z: 0 } },
        { texture: resources.outputTexture, origin: { x, y, z: 0 } },
        { width, height, depthOrArrayLayers: 1 }
      );
    }
  }
  const debugMinimalOutputWrite = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushMinimalOutputWrite");
  const debugMinimalBufferOnly = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushMinimalBufferOnly");
  if (debugMinimalBufferOnly) {
    // Debug-only: leave the main paint pass out so a storage-buffer probe can
    // prove whether raw compute submission is executing at all.
  } else if (debugMinimalOutputWrite && resources.outputTexture) {
    const shaderModule = device.createShaderModule({
      label: `${label}-debug-minimal-output-shader`,
      code: `
@group(0) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(0.0, 1.0, 0.0, 1.0));
}
`.trim()
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: `${label}-debug-minimal-output-bind-group-layout`,
      entries: [{
        binding: 0,
        visibility: 4,
        storageTexture: {
          access: "write-only",
          format: "rgba8unorm"
        }
      }]
    });
    const pipeline = device.createComputePipeline({
      label: `${label}-debug-minimal-output-pipeline`,
      layout: device.createPipelineLayout({
        label: `${label}-debug-minimal-output-pipeline-layout`,
        bindGroupLayouts: [bindGroupLayout]
      }),
      compute: {
        module: shaderModule,
        entryPoint: "main"
      }
    });
    const bindGroup = device.createBindGroup({
      label: `${label}-debug-minimal-output-bind-group`,
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: resources.outputTexture.createView()
      }]
    });
    const pass = commandEncoder.beginComputePass({
      label: `${label}-debug-minimal-output-compute-pass`
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z || 1);
    pass.end();
  } else if (projectedRenderPass) {
    const debugProjectedDirectColor = typeof window !== "undefined"
      && new URLSearchParams(window.location?.search || "").has("debugAirbrushProjectedDirectColor");
    if (resources.projectedMaskPipeline && resources.projectedMaskTexture) {
      const maskPass = commandEncoder.beginRenderPass({
        label: `${label}-projected-triangle-mask-pass`,
        colorAttachments: [{
          view: resources.projectedMaskTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      maskPass.setPipeline(resources.projectedMaskPipeline);
      maskPass.setBindGroup(0, resources.projectedRenderBindGroup);
      maskPass.draw(textureAirbrushProjectedRenderTriangleCount(plan) * 3, 1, 0, 0);
      maskPass.end();
    }
    const pass = commandEncoder.beginRenderPass({
      label: `${label}-projected-triangle-coverage-pass`,
      colorAttachments: [{
        view: (debugProjectedDirectColor ? resources.outputTexture : resources.projectedScratchTexture).createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: debugProjectedDirectColor ? "load" : "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(resources.projectedRenderPipeline);
    pass.setBindGroup(0, resources.projectedRenderBindGroup);
    pass.draw(textureAirbrushProjectedRenderTriangleCount(plan) * 3, 1, 0, 0);
    pass.end();
    const debugDisableProjectedSeamHeal = typeof window !== "undefined"
      && new URLSearchParams(window.location?.search || "").has("debugAirbrushDisableProjectedSeamHeal");
    const runProjectedSeamHeal = Boolean(resources.projectedMaskTexture) && !debugDisableProjectedSeamHeal && !debugProjectedDirectColor;
    if (runProjectedSeamHeal && resources.projectedSeamHealPipeline && resources.projectedSeamHealBindGroup && resources.projectedScratchTexture) {
      const healPass = commandEncoder.beginComputePass({
        label: `${label}-projected-seam-heal-compute-pass`
      });
      healPass.setPipeline(resources.projectedSeamHealPipeline);
      healPass.setBindGroup(0, resources.projectedSeamHealBindGroup);
      healPass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z || 1);
      healPass.end();
    }
  } else {
    const pass = commandEncoder.beginComputePass({
      label: `${label}-compute-pass`
    });
    pass.setPipeline(resources.pipeline);
    pass.setBindGroup(0, resources.bindGroup);
    pass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, plan.dispatch.z || 1);
    pass.end();
  }
  if (debugErrorScope) {
    const root = window?.document?.documentElement || null;
    if (root?.dataset) {
      root.dataset.textureAirbrushDebugDispatchWorkgroups = JSON.stringify(plan.dispatch || null);
      root.dataset.textureAirbrushDebugDispatchPaintBounds = JSON.stringify(plan.paintBounds || null);
      root.dataset.textureAirbrushDebugDispatchMinimalOutputWrite = String(debugMinimalOutputWrite);
      root.dataset.textureAirbrushDebugDispatchMinimalBufferOnly = String(debugMinimalBufferOnly);
      root.dataset.textureAirbrushDebugDispatchProjectedRenderPass = String(projectedRenderPass);
    }
  }
  const debugMinimalBufferWrite = typeof window !== "undefined"
    && new URLSearchParams(window.location?.search || "").has("debugAirbrushMinimalBufferWrite");
  let debugMinimalBufferReadback = null;
  if (debugMinimalBufferWrite) {
    const bufferUsage = typeof GPUBufferUsage !== "undefined"
      ? GPUBufferUsage
      : { STORAGE: 0x0080, COPY_SRC: 0x0004, COPY_DST: 0x0008, MAP_READ: 0x0001 };
    const storageBuffer = device.createBuffer({
      label: `${label}-debug-minimal-storage-buffer`,
      size: 16,
      usage: bufferUsage.STORAGE | bufferUsage.COPY_SRC
    });
    debugMinimalBufferReadback = device.createBuffer({
      label: `${label}-debug-minimal-storage-readback`,
      size: 16,
      usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ
    });
    const shaderModule = device.createShaderModule({
      label: `${label}-debug-minimal-buffer-shader`,
      code: `
struct DebugValues {
  values: array<u32, 4>,
};

@group(0) @binding(0) var<storage, read_write> debugValues: DebugValues;
@compute @workgroup_size(1, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) {
    debugValues.values[0] = 17u;
    debugValues.values[1] = 34u;
    debugValues.values[2] = 51u;
    debugValues.values[3] = 68u;
  }
}
`.trim()
    });
    const bindGroupLayout = device.createBindGroupLayout({
      label: `${label}-debug-minimal-buffer-bind-group-layout`,
      entries: [{
        binding: 0,
        visibility: 4,
        buffer: { type: "storage" }
      }]
    });
    const pipeline = device.createComputePipeline({
      label: `${label}-debug-minimal-buffer-pipeline`,
      layout: device.createPipelineLayout({
        label: `${label}-debug-minimal-buffer-pipeline-layout`,
        bindGroupLayouts: [bindGroupLayout]
      }),
      compute: {
        module: shaderModule,
        entryPoint: "main"
      }
    });
    const bindGroup = device.createBindGroup({
      label: `${label}-debug-minimal-buffer-bind-group`,
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: storageBuffer }
      }]
    });
    const pass = commandEncoder.beginComputePass({
      label: `${label}-debug-minimal-buffer-compute-pass`
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
    commandEncoder.copyBufferToBuffer(storageBuffer, 0, debugMinimalBufferReadback, 0, 16);
  }
  if (readback && resources.readbackBuffer) {
    const layout = plan.buffers.readback.layout;
    if (
      typeof window !== "undefined"
      && new URLSearchParams(window.location?.search || "").has("debugAirbrushCopySourceToOutput")
      && resources.sourceTexture
      && resources.outputTexture
      && typeof commandEncoder.copyTextureToTexture === "function"
    ) {
      commandEncoder.copyTextureToTexture(
        {
          texture: resources.sourceTexture,
          origin: {
            x: layout.x || 0,
            y: layout.y || 0,
            z: 0
          }
        },
        {
          texture: resources.outputTexture,
          origin: {
            x: layout.x || 0,
            y: layout.y || 0,
            z: 0
          }
        },
        {
          width: layout.width || plan.textures.output.size.width,
          height: layout.height || plan.textures.output.size.height,
          depthOrArrayLayers: 1
        }
      );
    }
    commandEncoder.copyTextureToBuffer(
      {
        texture: resources.outputTexture,
        origin: {
          x: layout.x || 0,
          y: layout.y || 0,
          z: 0
        }
      },
      {
        buffer: resources.readbackBuffer,
        bytesPerRow: layout.bytesPerRow,
        rowsPerImage: layout.rowsPerImage
      },
      {
        width: layout.width || plan.textures.output.size.width,
        height: layout.height || plan.textures.output.size.height,
        depthOrArrayLayers: 1
      }
    );
  }
  if (
    persistOutputToSource
    && resources.sourceTexture
    && resources.outputTexture
    && typeof commandEncoder.copyTextureToTexture === "function"
  ) {
    for (const region of dispatchCopyRegions) {
      commandEncoder.copyTextureToTexture(
        {
          texture: resources.outputTexture,
          origin: {
            x: region.x || 0,
            y: region.y || 0,
            z: 0
          }
        },
        {
          texture: resources.sourceTexture,
          origin: {
            x: region.x || 0,
            y: region.y || 0,
            z: 0
          }
        },
        {
          width: region.width || plan.textures.output.size.width,
          height: region.height || plan.textures.output.size.height,
          depthOrArrayLayers: 1
        }
      );
    }
  }
  const shouldSubmit = submit !== false && !providedCommandEncoder;
  const commandBuffer = shouldSubmit ? commandEncoder.finish() : null;
  if (commandBuffer) {
    device.queue?.submit?.([commandBuffer]);
  }
  if (debugMinimalBufferReadback) {
    const mapRead = typeof GPUMapMode !== "undefined" ? GPUMapMode.READ : 0x0001;
    Promise.resolve(device.queue?.onSubmittedWorkDone?.()).then(() => (
      debugMinimalBufferReadback.mapAsync(mapRead)
    )).then(() => {
      const bytes = Array.from(new Uint8Array(debugMinimalBufferReadback.getMappedRange()).slice(0, 16));
      debugMinimalBufferReadback.unmap?.();
      const root = window?.document?.documentElement || null;
      if (root?.dataset) {
        root.dataset.textureAirbrushDebugMinimalBufferBytes = JSON.stringify(bytes);
      }
    }).catch((error) => {
      const root = window?.document?.documentElement || null;
      if (root?.dataset) {
        root.dataset.textureAirbrushDebugMinimalBufferBytes = error?.message || String(error || "");
      }
    });
  }
  if (debugErrorScope) {
    try {
      device.popErrorScope().then((error) => {
        const root = window?.document?.documentElement || null;
        if (root?.dataset) {
          root.dataset.textureAirbrushDebugGpuValidationError = error?.message || "";
        }
      }).catch((error) => {
        const root = window?.document?.documentElement || null;
        if (root?.dataset) {
          root.dataset.textureAirbrushDebugGpuValidationError = error?.message || String(error || "");
        }
      });
    } catch (error) {
      const root = window?.document?.documentElement || null;
      if (root?.dataset) {
        root.dataset.textureAirbrushDebugGpuValidationError = error?.message || String(error || "");
      }
    }
  }
  return {
    device,
    commandEncoder: commandBuffer ? null : commandEncoder,
    commandBuffer,
    dispatch: plan.dispatch,
    outputTexture: resources.outputTexture,
    readbackBuffer: resources.readbackBuffer || null,
    readbackLayout: resources.readbackBuffer ? plan.buffers.readback.layout : null
  };
}

export function textureAirbrushRunWebGpuPaint(device, payload, options = {}) {
  const resources = createWebGpuPaintResources(device, payload, {
    entryPoint: TEXTURE_AIRBRUSH_WEBGPU_ENTRY_POINT,
    ...options
  });
  if (!resources) {
    return null;
  }
  return {
    resources,
    result: textureAirbrushDispatchWebGpuPaint(device, resources, options)
  };
}
