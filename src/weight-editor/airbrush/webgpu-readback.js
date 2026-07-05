function gpuMapReadValue(scope = globalThis) {
  return Number.isFinite(scope?.GPUMapMode?.READ)
    ? scope.GPUMapMode.READ
    : 0x0001;
}

export function textureAirbrushUnpackWebGpuReadbackRows(mapped, layout = null) {
  if (!mapped || !layout) {
    return null;
  }
  const source = new Uint8Array(mapped);
  const rows = Math.max(0, Math.floor(Number(layout.rowsPerImage) || 0));
  const bytesPerRow = Math.max(0, Math.floor(Number(layout.bytesPerRow) || 0));
  const unpaddedBytesPerRow = Math.max(0, Math.floor(Number(layout.unpaddedBytesPerRow) || 0));
  const pixels = new Uint8Array(unpaddedBytesPerRow * rows);
  for (let row = 0; row < rows; row += 1) {
    const sourceOffset = row * bytesPerRow;
    const targetOffset = row * unpaddedBytesPerRow;
    pixels.set(
      source.subarray(sourceOffset, sourceOffset + unpaddedBytesPerRow),
      targetOffset
    );
  }
  return pixels;
}

export async function textureAirbrushReadWebGpuPaintResult(result, {
  mapRead = gpuMapReadValue()
} = {}) {
  const buffer = result?.readbackBuffer;
  const layout = result?.readbackLayout;
  if (!buffer || !layout || typeof buffer.mapAsync !== "function") {
    return null;
  }
  await result?.device?.queue?.onSubmittedWorkDone?.();
  await buffer.mapAsync(mapRead);
  const mapped = buffer.getMappedRange();
  const pixels = textureAirbrushUnpackWebGpuReadbackRows(mapped, layout);
  buffer.unmap?.();
  return pixels;
}
