export const TEXTURE_AIRBRUSH_WEBGPU_ENTRY_POINT = "textureAirbrushPaint";
export { textureAirbrushReadWebGpuPaintResult } from "./webgpu-readback.js";
import { textureAirbrushCreateWebGpuPaintResources as createWebGpuPaintResources } from "./webgpu-resources.js";
export { textureAirbrushCreateWebGpuPaintResources } from "./webgpu-resources.js";

export function textureAirbrushWebGpuDeviceFromRenderer(renderer = null) {
  const backend = renderer?.backend || null;
  if (
    renderer?.isWebGPURenderer === true
    && backend?.isWebGPUBackend === true
    && backend?.isWebGLBackend !== true
    && backend?.device
  ) {
    return backend.device;
  }
  return null;
}

export function textureAirbrushDispatchWebGpuPaint(device, resources, {
  readback = false,
  persistOutputToSource = false,
  label = "texture-airbrush"
} = {}) {
  const plan = resources?.plan;
  if (!device || !resources || !plan) {
    return null;
  }
  const commandEncoder = device.createCommandEncoder({
    label: `${label}-command-encoder`
  });
  const pass = commandEncoder.beginComputePass({
    label: `${label}-compute-pass`
  });
  pass.setPipeline(resources.pipeline);
  pass.setBindGroup(0, resources.bindGroup);
  pass.dispatchWorkgroups(plan.dispatch.x, plan.dispatch.y, 1);
  pass.end();
  if (readback && resources.readbackBuffer) {
    const layout = plan.buffers.readback.layout;
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
    const layout = plan.buffers.readback.layout;
    commandEncoder.copyTextureToTexture(
      {
        texture: resources.outputTexture,
        origin: {
          x: layout.x || 0,
          y: layout.y || 0,
          z: 0
        }
      },
      {
        texture: resources.sourceTexture,
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
  const commandBuffer = commandEncoder.finish();
  device.queue?.submit?.([commandBuffer]);
  return {
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
