export const TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT = "rgba8unorm";
export const TEXTURE_AIRBRUSH_WEBGPU_BRUSH_UNIFORM_BYTES = 64;
export const TEXTURE_AIRBRUSH_WEBGPU_STROKE_SEGMENT_FLOATS = 4;
export const TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_PIXEL = 4;
export const TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_ROW_ALIGNMENT = 256;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  return Math.max(1, Math.floor(finiteNumber(value, fallback)));
}

function usageFlag(scope, groupName, name, fallback) {
  const group = scope?.[groupName] || globalThis?.[groupName] || null;
  return Number.isFinite(group?.[name]) ? group[name] : fallback;
}

export function textureAirbrushWebGpuUsageConstants(scope = globalThis) {
  return {
    buffer: {
      mapRead: usageFlag(scope, "GPUBufferUsage", "MAP_READ", 0x0001),
      copyDst: usageFlag(scope, "GPUBufferUsage", "COPY_DST", 0x0008),
      uniform: usageFlag(scope, "GPUBufferUsage", "UNIFORM", 0x0040),
      storage: usageFlag(scope, "GPUBufferUsage", "STORAGE", 0x0080)
    },
    texture: {
      copySrc: usageFlag(scope, "GPUTextureUsage", "COPY_SRC", 0x01),
      copyDst: usageFlag(scope, "GPUTextureUsage", "COPY_DST", 0x02),
      textureBinding: usageFlag(scope, "GPUTextureUsage", "TEXTURE_BINDING", 0x04),
      storageBinding: usageFlag(scope, "GPUTextureUsage", "STORAGE_BINDING", 0x08)
    },
    shaderStage: {
      compute: usageFlag(scope, "GPUShaderStage", "COMPUTE", 0x04)
    }
  };
}

export function textureAirbrushWebGpuAlignedBytesPerRow(width, {
  bytesPerPixel = TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_PIXEL,
  alignment = TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_ROW_ALIGNMENT
} = {}) {
  const rawBytes = positiveInteger(width, 1) * positiveInteger(bytesPerPixel, TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_PIXEL);
  const alignTo = positiveInteger(alignment, TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_ROW_ALIGNMENT);
  return Math.ceil(rawBytes / alignTo) * alignTo;
}

export function textureAirbrushWebGpuReadbackLayout(width, height) {
  const safeWidth = positiveInteger(width, 1);
  const safeHeight = positiveInteger(height, 1);
  const bytesPerRow = textureAirbrushWebGpuAlignedBytesPerRow(safeWidth);
  return {
    bytesPerRow,
    rowsPerImage: safeHeight,
    byteLength: bytesPerRow * safeHeight,
    unpaddedBytesPerRow: safeWidth * TEXTURE_AIRBRUSH_WEBGPU_BYTES_PER_PIXEL
  };
}

export function textureAirbrushWebGpuTextureDescriptors(width, height, scope = globalThis) {
  const usage = textureAirbrushWebGpuUsageConstants(scope).texture;
  const size = {
    width: positiveInteger(width, 1),
    height: positiveInteger(height, 1),
    depthOrArrayLayers: 1
  };
  return {
    source: {
      size,
      format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
      usage: usage.textureBinding | usage.copyDst
    },
    strokeSource: {
      size,
      format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
      usage: usage.textureBinding | usage.copyDst
    },
    output: {
      size,
      format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT,
      usage: usage.storageBinding | usage.copySrc | usage.copyDst
    }
  };
}

export function textureAirbrushWebGpuBufferDescriptors(uniformData, strokeData, scope = globalThis) {
  const usage = textureAirbrushWebGpuUsageConstants(scope).buffer;
  return {
    uniform: {
      size: uniformData.byteLength,
      usage: usage.uniform | usage.copyDst,
      data: uniformData
    },
    strokes: {
      size: Math.max(16, strokeData.byteLength),
      usage: usage.storage | usage.copyDst,
      data: strokeData
    }
  };
}

export function textureAirbrushWebGpuReadbackBufferDescriptor(width, height, scope = globalThis, paintBounds = null) {
  const usage = textureAirbrushWebGpuUsageConstants(scope).buffer;
  const bounds = paintBounds || {
    x: 0,
    y: 0,
    width: positiveInteger(width, 1),
    height: positiveInteger(height, 1)
  };
  const layout = {
    ...textureAirbrushWebGpuReadbackLayout(bounds.width, bounds.height),
    x: Math.max(0, Math.floor(finiteNumber(bounds.x, 0))),
    y: Math.max(0, Math.floor(finiteNumber(bounds.y, 0))),
    width: positiveInteger(bounds.width, 1),
    height: positiveInteger(bounds.height, 1)
  };
  return {
    size: layout.byteLength,
    usage: usage.mapRead | usage.copyDst,
    layout
  };
}

export function textureAirbrushWebGpuBindGroupLayoutEntries(scope = globalThis) {
  const compute = textureAirbrushWebGpuUsageConstants(scope).shaderStage.compute;
  return [
    {
      binding: 0,
      visibility: compute,
      texture: { sampleType: "float" }
    },
    {
      binding: 1,
      visibility: compute,
      storageTexture: {
        access: "write-only",
        format: TEXTURE_AIRBRUSH_WEBGPU_TEXTURE_FORMAT
      }
    },
    {
      binding: 2,
      visibility: compute,
      buffer: { type: "uniform" }
    },
    {
      binding: 3,
      visibility: compute,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 4,
      visibility: compute,
      texture: { sampleType: "float" }
    }
  ];
}
