function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finitePoint(point = null) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  return {
    x: point.x,
    y: point.y
  };
}

function clientEventFromPoint(point = null, sourceEvent = null) {
  if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) {
    return null;
  }
  return {
    clientX: point.clientX,
    clientY: point.clientY,
    pointerType: sourceEvent?.pointerType || "",
    pressure: sourceEvent?.pressure,
    button: sourceEvent?.button ?? 0,
    buttons: sourceEvent?.buttons ?? 1,
    altKey: Boolean(sourceEvent?.altKey),
    ctrlKey: Boolean(sourceEvent?.ctrlKey),
    metaKey: Boolean(sourceEvent?.metaKey),
    shiftKey: Boolean(sourceEvent?.shiftKey),
    preventDefault: () => {},
    stopPropagation: () => {}
  };
}

function materialEditableDebug(material = null, editable = null) {
  const userData = material?.userData || {};
  const gpuEntry = userData.textureAirbrushGpuTarget || null;
  const map = material?.map || null;
  return {
    hasMaterial: Boolean(material),
    hasMap: Boolean(map),
    mapName: map?.name || "",
    mapImageType: map?.image?.constructor?.name || "",
    mapImageWidth: map?.image?.width || map?.image?.naturalWidth || 0,
    mapImageHeight: map?.image?.height || map?.image?.naturalHeight || 0,
    hasCloneCanvas: Boolean(userData.clonePaintCanvas),
    hasCloneContext: Boolean(userData.clonePaintContext),
    cloneTextureMatchesMap: Boolean(userData.clonePaintTexture && userData.clonePaintTexture === map),
    hasGpuEntry: Boolean(gpuEntry),
    gpuEntryMatchesMap: Boolean(gpuEntry?.target?.texture && map === gpuEntry.target.texture),
    gpuSourceName: gpuEntry?.sourceTexture?.name || "",
    gpuSourceImageType: gpuEntry?.sourceTexture?.image?.constructor?.name || "",
    gpuSourceImageWidth: gpuEntry?.sourceTexture?.image?.width || gpuEntry?.sourceTexture?.image?.naturalWidth || 0,
    gpuSourceImageHeight: gpuEntry?.sourceTexture?.image?.height || gpuEntry?.sourceTexture?.image?.naturalHeight || 0,
    hasEditable: Boolean(editable),
    hasEditableCanvas: Boolean(editable?.canvas),
    hasEditableContext: Boolean(editable?.context),
    hasEditableTexture: Boolean(editable?.texture)
  };
}

function hitDebug(record = null, hit = null) {
  const uv = hit?.uv || null;
  return {
    hasRecord: Boolean(record),
    objectName: record?.object?.name || hit?.object?.name || "",
    hasHit: Boolean(hit),
    hasUv: Boolean(uv),
    uvX: Number.isFinite(uv?.x) ? uv.x : null,
    uvY: Number.isFinite(uv?.y) ? uv.y : null,
    distance: Number.isFinite(hit?.distance) ? hit.distance : null,
    faceIndex: Number.isInteger(hit?.faceIndex) ? hit.faceIndex : null,
    materialIndex: Number.isInteger(hit?.face?.materialIndex) ? hit.face.materialIndex : null
  };
}

export function textureAirbrushWebGpuTextureRadiusPixels(editor = null, editable = null, options = {}) {
  const canvas = editable?.canvas || null;
  const maxTextureSize = Math.max(1, canvas?.width || 1, canvas?.height || 1);
  const radiusScale = Number.isFinite(Number(options.textureRadiusScale))
    ? Number(options.textureRadiusScale)
    : options.target?.vertices?.size
      ? 1.55
      : 0.72;
  const baseTextureRadius = Math.max(
    0.75,
    finiteNumber(editor?.textureBrushRadiusValue?.(), 0.035) * maxTextureSize * radiusScale
  );
  if (Number.isFinite(Number(options.textureRadiusPixels))) {
    return Math.max(0.75, Number(options.textureRadiusPixels));
  }
  if (!Number.isFinite(Number(options.radiusPixels))) {
    return baseTextureRadius;
  }
  const baseScreenRadius = Math.max(0.75, finiteNumber(editor?.textureBrushRadiusScreenPixels?.(), 24));
  return Math.max(0.75, baseTextureRadius * Math.max(0.02, Number(options.radiusPixels) / baseScreenRadius));
}

export function textureAirbrushWebGpuStrokeEstimate(candidate = null) {
  const radius = Math.max(0.75, finiteNumber(candidate?.radiusPixels, 0.75));
  const segments = Array.isArray(candidate?.strokeSegments) ? candidate.strokeSegments : [];
  const length = segments.reduce((total, segment) => {
    const start = finitePoint(segment?.start);
    const end = finitePoint(segment?.end);
    if (!start || !end) {
      return total;
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return total + Math.sqrt(dx * dx + dy * dy);
  }, 0);
  return Math.max(1, Math.round(Math.PI * radius * radius + length * radius * 2));
}

export function textureAirbrushWebGpuStrokeCandidateFromHit(editor = null, record = null, hit = null, event = null, options = {}) {
  const hitUv = hit?.uv || null;
  if (!record || !hitUv) {
    options.debugReject?.("missing-record-or-uv", hitDebug(record, hit));
    return null;
  }
  const material = editor?.clonePaintMaterialForHit?.(record, hit);
  const editable = editor?.editableClonePaintTexture?.(material);
  if (!material || !editable?.canvas || !editable?.texture) {
    options.debugReject?.("missing-material-or-editable", materialEditableDebug(material, editable));
    return null;
  }

  const target = options.target || (hit?.cloneRegionHit ? editor?.clonePaintTargets?.get?.(record) : null);
  const materialIndex = hit?.face?.materialIndex
    ?? target?.originMaterialIndex
    ?? target?.materialIndex
    ?? 0;
  if (editor?.textureAirbrushNeighborHitAllowed?.(
    options.neighborPaintSeed || null,
    record,
    hit,
    material,
    materialIndex
  ) === false) {
    options.debugReject?.("neighbor-rejected", {
      ...hitDebug(record, hit),
      materialName: material?.name || "",
      materialIndex
    });
    return null;
  }
  const center = target?.vertices?.size
    ? editor?.textureAirbrushRegionPixelFromUv?.(
      hitUv,
      editable.canvas,
      editable.texture,
      options.referenceUv || target.originUv || target.uvCenter || hitUv
    )
    : editor?.clonePaintPixelFromUv?.(hitUv, editable.canvas, editable.texture, { wrap: true });
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    options.debugReject?.("missing-texture-center", {
      ...hitDebug(record, hit),
      editable: materialEditableDebug(material, editable)
    });
    return null;
  }

  let start = center;
  const startEvent = clientEventFromPoint(options.strokeStart, event);
  if (startEvent && typeof editor?.texturePaintHitForEvent === "function") {
    const startHit = editor.texturePaintHitForEvent(startEvent, "airbrush");
    const startMaterial = editor.clonePaintMaterialForHit?.(startHit?.record, startHit?.hit);
    const startMaterialIndex = startHit?.hit?.face?.materialIndex ?? materialIndex;
    if (startHit?.record === record && startMaterial === material && startMaterialIndex === materialIndex && startHit?.hit?.uv) {
      const startPixel = target?.vertices?.size
        ? editor?.textureAirbrushRegionPixelFromUv?.(
          startHit.hit.uv,
          editable.canvas,
          editable.texture,
          options.referenceUv || target.originUv || target.uvCenter || hitUv
        )
        : editor?.clonePaintPixelFromUv?.(startHit.hit.uv, editable.canvas, editable.texture, { wrap: true });
      if (startPixel && Number.isFinite(startPixel.x) && Number.isFinite(startPixel.y)) {
        start = startPixel;
      }
    }
  }

  const radiusPixels = textureAirbrushWebGpuTextureRadiusPixels(editor, editable, {
    ...options,
    target
  });
  const strokeSegments = [{
    start: {
      x: start.x,
      y: start.y
    },
    end: {
      x: center.x,
      y: center.y
    }
  }];
  const brushOptions = {
    ...options,
    radiusPixels,
    opacity: Number.isFinite(Number(options.opacity))
      ? Math.max(0.001, Math.min(1, Number(options.opacity)))
      : editor?.textureAirbrushOpacity?.() ?? 0.42,
    hardness: Number.isFinite(Number(options.hardness))
      ? Math.max(0, Math.min(1, Number(options.hardness)))
      : editor?.textureAirbrushHardness?.() ?? 0.35,
    scatter: Number.isFinite(Number(options.scatter))
      ? Math.max(0, Math.min(1, Number(options.scatter)))
      : editor?.textureAirbrushScatter?.() ?? 0.35,
    strength: Number.isFinite(Number(options.strength))
      ? Math.max(0, Number(options.strength))
      : 1,
    color: options.color || editor?.textureAirbrushColor?.() || { r: 255, g: 255, b: 255 },
    strokeSegments
  };
  const candidate = {
    record,
    hit,
    target,
    material,
    materialIndex,
    editable,
    center: {
      x: center.x,
      y: center.y
    },
    start: {
      x: start.x,
      y: start.y
    },
    radiusPixels,
    strokeSegments,
    options: brushOptions
  };
  candidate.estimate = textureAirbrushWebGpuStrokeEstimate(candidate);
  return candidate;
}
