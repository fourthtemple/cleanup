function typedArrayByteLength(data) {
  return Number.isFinite(data?.byteLength) ? data.byteLength : 0;
}

function writeBufferData(queue, buffer, data) {
  if (!queue?.writeBuffer || !buffer || !data) {
    return false;
  }
  if (data.buffer instanceof ArrayBuffer) {
    queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset || 0, typedArrayByteLength(data));
    return true;
  }
  queue.writeBuffer(buffer, 0, data, 0, typedArrayByteLength(data));
  return true;
}

function reusablePaintResources(resources = null, payload = null) {
  const plan = payload?.plan;
  const source = payload?.source;
  if (
    !resources
    || !plan
    || resources.source !== source
    || resources.width !== plan.width
    || resources.height !== plan.height
    || !resources.pipeline
    || !resources.bindGroup
    || !resources.sourceTexture
    || !resources.strokeSourceTexture
    || !resources.visibilityMaskTexture
    || !resources.outputTexture
    || !resources.uniformBuffer
    || !resources.strokeBuffer
  ) {
    return false;
  }
  return true;
}

function reusableReadbackBuffer(resources = null, plan = null) {
  const buffer = resources?.readbackBuffer || null;
  const descriptor = plan?.buffers?.readback || null;
  if (!buffer || !descriptor) {
    return null;
  }
  const size = Number(buffer.desc?.size ?? buffer.size ?? 0);
  const usage = Number(buffer.desc?.usage ?? buffer.usage ?? 0);
  if (size === descriptor.size && usage === descriptor.usage) {
    return buffer;
  }
  return null;
}

function textureAirbrushDefaultVisibleMaskPixels(plan) {
  const byteLength = Math.max(1, Math.floor(Number(plan?.width) || 1))
    * Math.max(1, Math.floor(Number(plan?.height) || 1))
    * 4;
  const pixels = new Uint8Array(byteLength);
  pixels.fill(255);
  return pixels;
}

function textureAirbrushUploadWebGpuTexture(device, texture, pixels, plan, textureDescriptor = null) {
  if (!pixels || !device?.queue?.writeTexture || !texture || !plan) {
    return false;
  }
  device.queue.writeTexture(
    { texture },
    pixels,
    {
      bytesPerRow: plan.width * 4,
      rowsPerImage: plan.height
    },
    (textureDescriptor || plan.textures.source).size
  );
  return true;
}

function textureAirbrushUploadWebGpuSourceTexture(device, texture, sourcePixels, plan) {
  return textureAirbrushUploadWebGpuTexture(device, texture, sourcePixels, plan, plan.textures.source);
}

function textureAirbrushUploadWebGpuVisibilityMaskTexture(device, texture, visibilityMaskPixels, plan) {
  if (!visibilityMaskPixels && !plan?.params?.useVisibilityMask) {
    return false;
  }
  return textureAirbrushUploadWebGpuTexture(
    device,
    texture,
    visibilityMaskPixels || textureAirbrushDefaultVisibleMaskPixels(plan),
    plan,
    plan.textures.visibilityMask
  );
}

export function textureAirbrushCreateWebGpuPaintResources(device, payload, {
  sourcePixels = null,
  strokeSourcePixels = null,
  readback = false,
  label = "texture-airbrush",
  reuseResources = null,
  visibilityMaskPixels = null,
  uploadSource = true,
  uploadStrokeSource = strokeSourcePixels ? true : uploadSource,
  uploadVisibilityMask = null,
  entryPoint = "textureAirbrushPaint"
} = {}) {
  const plan = payload?.plan;
  const source = payload?.source;
  if (!device || !plan || typeof source !== "string") {
    return null;
  }
  const shouldUploadVisibilityMask = uploadVisibilityMask === null
    ? Boolean(visibilityMaskPixels || plan.params?.useVisibilityMask)
    : uploadVisibilityMask !== false;

  if (reusablePaintResources(reuseResources, payload)) {
    const readbackBuffer = readback
      ? reusableReadbackBuffer(reuseResources, plan) || device.createBuffer({
          label: `${label}-readback-buffer`,
          size: plan.buffers.readback.size,
          usage: plan.buffers.readback.usage
        })
      : null;
    const resources = {
      ...reuseResources,
      plan,
      readbackBuffer,
      readbackBufferReused: readbackBuffer === reuseResources.readbackBuffer
    };
    writeBufferData(device.queue, resources.uniformBuffer, plan.buffers.uniform.data);
    writeBufferData(device.queue, resources.strokeBuffer, plan.buffers.strokes.data);
    if (uploadSource !== false) {
      textureAirbrushUploadWebGpuSourceTexture(device, resources.sourceTexture, sourcePixels, plan);
    }
    if (uploadStrokeSource !== false) {
      textureAirbrushUploadWebGpuSourceTexture(
        device,
        resources.strokeSourceTexture,
        strokeSourcePixels || sourcePixels,
        plan
      );
    }
    if (shouldUploadVisibilityMask) {
      textureAirbrushUploadWebGpuVisibilityMaskTexture(
        device,
        resources.visibilityMaskTexture,
        visibilityMaskPixels,
        plan
      );
    }
    return resources;
  }

  const shaderModule = device.createShaderModule({
    label: `${label}-shader`,
    code: source
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: `${label}-bind-group-layout`,
    entries: plan.bindGroupLayoutEntries
  });
  const pipelineLayout = device.createPipelineLayout({
    label: `${label}-pipeline-layout`,
    bindGroupLayouts: [bindGroupLayout]
  });
  const pipeline = device.createComputePipeline({
    label: `${label}-pipeline`,
    layout: pipelineLayout,
    compute: {
      module: shaderModule,
      entryPoint
    }
  });
  const sourceTexture = device.createTexture({
    label: `${label}-source-texture`,
    ...plan.textures.source
  });
  const strokeSourceTexture = device.createTexture({
    label: `${label}-stroke-source-texture`,
    ...plan.textures.strokeSource
  });
  const visibilityMaskTexture = device.createTexture({
    label: `${label}-visibility-mask-texture`,
    ...plan.textures.visibilityMask
  });
  const outputTexture = device.createTexture({
    label: `${label}-output-texture`,
    ...plan.textures.output
  });
  const uniformBuffer = device.createBuffer({
    label: `${label}-uniform-buffer`,
    size: plan.buffers.uniform.size,
    usage: plan.buffers.uniform.usage
  });
  const strokeBuffer = device.createBuffer({
    label: `${label}-stroke-buffer`,
    size: plan.buffers.strokes.size,
    usage: plan.buffers.strokes.usage
  });
  const readbackBuffer = readback
    ? device.createBuffer({
        label: `${label}-readback-buffer`,
        size: plan.buffers.readback.size,
        usage: plan.buffers.readback.usage
      })
    : null;

  writeBufferData(device.queue, uniformBuffer, plan.buffers.uniform.data);
  writeBufferData(device.queue, strokeBuffer, plan.buffers.strokes.data);
  textureAirbrushUploadWebGpuSourceTexture(device, sourceTexture, sourcePixels, plan);
  textureAirbrushUploadWebGpuSourceTexture(device, strokeSourceTexture, strokeSourcePixels || sourcePixels, plan);
  if (shouldUploadVisibilityMask) {
    textureAirbrushUploadWebGpuVisibilityMaskTexture(device, visibilityMaskTexture, visibilityMaskPixels, plan);
  }

  const bindGroup = device.createBindGroup({
    label: `${label}-bind-group`,
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: sourceTexture.createView()
      },
      {
        binding: 1,
        resource: outputTexture.createView()
      },
      {
        binding: 2,
        resource: { buffer: uniformBuffer }
      },
      {
        binding: 3,
        resource: { buffer: strokeBuffer }
      },
      {
        binding: 4,
        resource: strokeSourceTexture.createView()
      },
      {
        binding: 5,
        resource: visibilityMaskTexture.createView()
      }
    ]
  });

  return {
    plan,
    source,
    width: plan.width,
    height: plan.height,
    shaderModule,
    bindGroupLayout,
    pipelineLayout,
    pipeline,
    sourceTexture,
    strokeSourceTexture,
    visibilityMaskTexture,
    outputTexture,
    uniformBuffer,
    strokeBuffer,
    readbackBuffer,
    readbackBufferReused: false,
    bindGroup
  };
}
