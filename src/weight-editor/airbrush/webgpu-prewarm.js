import { textureAirbrushPrewarmWebGpuStrokeGeometry } from "./webgpu-stroke.js";
import {
  texturePaintPrewarmTslSurfaceAirbrush
} from "../../texture-paint/surface-airbrush-tsl.js";

function materialsForRecord(record = null) {
  return Array.isArray(record?.object?.material)
    ? record.object.material
    : [record?.object?.material].filter(Boolean);
}

function paintableMaterialFromRecord(editor = null, record = null) {
  const materials = materialsForRecord(record);
  return materials.find((material) => material && (material.map || material.color)) || null;
}

function paintablesFromRecords(editor = null) {
  const records = (editor?.textureAirbrushRecords?.() || editor?.paintRecords || [])
    .filter((record) => record?.object);
  const paintables = [];
  for (const record of records) {
    const materials = materialsForRecord(record);
    for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
      const material = materials[materialIndex];
      if (material && (material.map || material.color)) {
        paintables.push({ record, material, materialIndex });
      }
    }
  }
  return paintables;
}

function preferredPrewarmMaterial(editor = null, options = {}) {
  return options.material
    || editor?.texturePaintActiveMaterial
    || null;
}

function prioritizePrewarmPaintables(editor = null, paintables = [], options = {}) {
  const preferred = preferredPrewarmMaterial(editor, options);
  if (!preferred || !Array.isArray(paintables) || !paintables.length) {
    return Array.isArray(paintables) ? paintables : [];
  }
  const priority = [];
  const rest = [];
  for (const paintable of paintables) {
    if (paintable?.material === preferred) {
      priority.push(paintable);
    } else {
      rest.push(paintable);
    }
  }
  return priority.length ? [...priority, ...rest] : paintables;
}

function textureAirbrushPrewarmPaintables(editor = null, options = {}) {
  const paintables = typeof editor?.textureAirbrushPaintableMaterials === "function"
    ? editor.textureAirbrushPaintableMaterials()
    : paintablesFromRecords(editor);
  return prioritizePrewarmPaintables(editor, paintables, options);
}

function baseEditableForMaterial(material = null, editable = null) {
  const canvas = editable?.compositeCanvas
    || material?.userData?.clonePaintCanvas
    || (!editable?.layerMode ? editable?.canvas : null)
    || null;
  const context = editable?.compositeContext
    || material?.userData?.clonePaintContext
    || (!editable?.layerMode ? editable?.context : null)
    || null;
  if (!canvas || !context) {
    return null;
  }
  return {
    ...(editable || {}),
    canvas,
    context,
    texture: material?.userData?.clonePaintTexture || editable?.texture || material?.map || null,
    compositeCanvas: undefined,
    compositeContext: undefined,
    layer: undefined,
    layerStack: undefined,
    layerMode: false
  };
}

function layerEditableForMaterial(material = null, baseEditable = null) {
  const stack = material?.userData?.texturePaintLayerStack || null;
  const layer = stack?.layers?.find((item) => item.id === stack.activeLayerId) || null;
  if (!layer?.canvas || !layer.context || !baseEditable?.canvas || !baseEditable?.context) {
    return null;
  }
  return {
    ...baseEditable,
    canvas: layer.canvas,
    context: layer.context,
    compositeCanvas: baseEditable.canvas,
    compositeContext: baseEditable.context,
    layer,
    layerStack: stack,
    layerMode: true
  };
}

function editablePrewarmVariants(material = null, editable = null) {
  const variants = [];
  const add = (candidate = null) => {
    if (!candidate?.canvas || !candidate.context) {
      return;
    }
    if (variants.some((item) => item.canvas === candidate.canvas)) {
      return;
    }
    variants.push(candidate);
  };
  const baseEditable = baseEditableForMaterial(material, editable);
  const layerEditable = layerEditableForMaterial(material, baseEditable || editable);
  if (editable?.layerMode === true) {
    add(editable);
  }
  add(layerEditable);
  add(baseEditable);
  add(editable);
  return variants;
}

function tslSurfacePrewarmCandidate(record = null, hit = null, material = null, editable = null, materialIndex = null) {
  if (!record?.object || !material || !editable?.canvas) {
    return null;
  }
  const resolvedHit = hit || {
    object: record.object,
    face: Number.isFinite(Number(materialIndex))
      ? { materialIndex: Math.max(0, Math.floor(Number(materialIndex) || 0)) }
      : undefined
  };
  return {
    record,
    hit: resolvedHit,
    material,
    editable,
    materialIndex: Math.max(
      0,
      Math.floor(Number(materialIndex ?? resolvedHit?.face?.materialIndex) || 0)
    )
  };
}

function webGpuBackendReady(editor = null) {
  const resolved = editor?.textureAirbrushResolveBackend?.({ webgpu: true });
  return resolved?.backend === "webgpu";
}

function textureAirbrushStrokeUsesTslSurfaceTarget(stroke = null) {
  return (stroke?.before || []).some((entry) => {
    if (entry?.type !== "gpu") {
      return false;
    }
    const targetData = entry.targetEntry?.target?.texture?.userData || null;
    const displayData = entry.targetEntry?.displayTarget?.texture?.userData || null;
    return targetData?.texturePaintTslSurfaceAirbrushTargetTexture === true
      || displayData?.texturePaintTslSurfaceAirbrushDisplayTexture === true;
  });
}

function scheduledPrewarmOptions(options = {}, force = false) {
  const scheduled = {
    force: force || options.force === true
  };
  if (options.all === true) {
    scheduled.all = true;
  }
  if (Number.isFinite(Number(options.limit))) {
    scheduled.limit = Number(options.limit);
  }
  if (Number.isFinite(Number(options.tslSurfacePrewarmLimit))) {
    scheduled.tslSurfacePrewarmLimit = Math.max(1, Math.floor(Number(options.tslSurfacePrewarmLimit)));
  }
  if (options.immediateLayer === false) {
    scheduled.immediateLayer = false;
  }
  if (options.renderCompilePass === true) {
    scheduled.renderCompilePass = true;
  } else if (options.renderCompilePass === false) {
    scheduled.renderCompilePass = false;
  }
  if (options.preserveLayerDisplay === true) {
    scheduled.preserveLayerDisplay = true;
  }
  for (const key of [
    "allowImmediatePrewarm",
    "liveDisplayExternalTexture",
    "allowPrewarmLiveDisplayMaterialSwap",
    "externalSourceUpload",
    "warmScreenHitIndex",
    "warmNeighborTopology",
    "ensureStrokeSourceImageData",
    "prewarmPaintablesWithoutHit",
    "deferLiveDisplayMipmaps",
    "liveDisplayMipmaps",
    "tslSurfacePrewarmAll",
    "tslSurfacePrewarmHit"
  ]) {
    if (options[key] === true) {
      scheduled[key] = true;
    } else if (options[key] === false) {
      scheduled[key] = false;
    }
  }
  if (options.refreshSource === true) {
    scheduled.refreshSource = true;
  }
  if (options.skipHitLookup === true) {
    scheduled.skipHitLookup = true;
  }
  if (options.material) {
    scheduled.material = options.material;
  }
  if (options.label) {
    scheduled.label = String(options.label);
  }
  if (Number.isFinite(Number(options.delay))) {
    scheduled.delay = Number(options.delay);
  }
  return scheduled;
}

function mergeScheduledPrewarmOptions(previous = null, next = {}, force = false) {
  const merged = {
    ...(previous || {}),
    ...scheduledPrewarmOptions(next, force)
  };
  if (previous?.force === true || next?.force === true || force) {
    merged.force = true;
  }
  if (previous?.all === true || next?.all === true) {
    merged.all = true;
  }
  if (previous?.preserveLayerDisplay === true || next?.preserveLayerDisplay === true) {
    merged.preserveLayerDisplay = true;
  }
  for (const key of [
    "allowImmediatePrewarm",
    "liveDisplayExternalTexture",
    "allowPrewarmLiveDisplayMaterialSwap",
    "externalSourceUpload",
    "warmScreenHitIndex",
    "warmNeighborTopology",
    "ensureStrokeSourceImageData",
    "prewarmPaintablesWithoutHit",
    "deferLiveDisplayMipmaps",
    "liveDisplayMipmaps",
    "tslSurfacePrewarmAll",
    "tslSurfacePrewarmHit",
    "renderCompilePass"
  ]) {
    if (previous?.[key] === true || next?.[key] === true) {
      merged[key] = true;
    } else if (previous?.[key] === false || next?.[key] === false) {
      merged[key] = false;
    }
  }
  if (previous?.refreshSource === true || next?.refreshSource === true) {
    merged.refreshSource = true;
  }
  if (previous?.skipHitLookup === true && next?.skipHitLookup !== false) {
    merged.skipHitLookup = true;
  }
  if (next?.material) {
    merged.material = next.material;
  } else if (previous?.material) {
    merged.material = previous.material;
  }
  if (next?.label) {
    merged.label = String(next.label);
  } else if (previous?.label) {
    merged.label = String(previous.label);
  }
  if (Number.isFinite(Number(previous?.limit)) && Number.isFinite(Number(next?.limit))) {
    merged.limit = Math.max(Number(previous.limit), Number(next.limit));
  }
  if (
    Number.isFinite(Number(previous?.tslSurfacePrewarmLimit))
    && Number.isFinite(Number(next?.tslSurfacePrewarmLimit))
  ) {
    merged.tslSurfacePrewarmLimit = Math.max(
      Number(previous.tslSurfacePrewarmLimit),
      Number(next.tslSurfacePrewarmLimit)
    );
  }
  return merged;
}

function debugWebGpuPrewarm(label = "", detail = {}) {
  if (
    typeof window === "undefined"
    || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")
  ) {
    return;
  }
  const root = window.document?.documentElement || null;
  if (!root?.dataset) {
    return;
  }
  root.dataset.textureAirbrushDebugPrewarmCount = String(
    Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugPrewarmCount) || 0)) + 1
  );
  root.dataset.textureAirbrushDebugPrewarmLabel = label;
  root.dataset.textureAirbrushDebugPrewarmSummary = JSON.stringify({
    reason: detail.reason || "",
    backendReady: detail.backendReady ?? null,
    hasEditableCanvas: detail.hasEditableCanvas ?? null,
    hasMaterial: detail.hasMaterial ?? null,
    paintableCount: detail.paintableCount ?? null,
    warmed: detail.warmed ?? null,
    liveDisplayExternalTexture: detail.liveDisplayExternalTexture ?? null,
    allowPrewarmLiveDisplayMaterialSwap: detail.allowPrewarmLiveDisplayMaterialSwap ?? null,
    liveDisplayFullUpdate: detail.liveDisplayFullUpdate ?? null,
    liveDisplayWorkPixels: detail.liveDisplayWorkPixels ?? null
  });
  if (label === "skip") {
    root.dataset.textureAirbrushDebugPrewarmSkipCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugPrewarmSkipCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugPrewarmSkipReason = String(detail.reason || "");
  } else if (label === "result") {
    root.dataset.textureAirbrushDebugPrewarmResultCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugPrewarmResultCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugPrewarmWarmed = String(detail.warmed ?? "");
    root.dataset.textureAirbrushDebugPrewarmLiveDisplayExternalTexture = String(
      detail.liveDisplayExternalTexture ?? ""
    );
    root.dataset.textureAirbrushDebugPrewarmLiveDisplayFullUpdate = String(
      detail.liveDisplayFullUpdate ?? ""
    );
    root.dataset.textureAirbrushDebugPrewarmLiveDisplayWorkPixels = String(
      detail.liveDisplayWorkPixels ?? ""
    );
  }
}

function debugWebGpuScheduledPrewarm(label = "", detail = {}) {
  if (
    typeof window === "undefined"
    || !new URLSearchParams(window.location?.search || "").has("debugAirbrush")
  ) {
    return;
  }
  const root = window.document?.documentElement || null;
  if (!root?.dataset) {
    return;
  }
  root.dataset.textureAirbrushDebugScheduledPrewarmCount = String(
    Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugScheduledPrewarmCount) || 0)) + 1
  );
  root.dataset.textureAirbrushDebugScheduledPrewarmLabel = label;
  root.dataset.textureAirbrushDebugScheduledPrewarmSummary = JSON.stringify({
    force: detail.force ?? null,
    activeTool: detail.activeTool || "",
    hasModel: detail.hasModel ?? null,
    pending: detail.pending ?? null,
    all: detail.all ?? null,
    liveDisplayExternalTexture: detail.liveDisplayExternalTexture ?? null,
    reason: detail.reason || ""
  });
  if (label === "run") {
    root.dataset.textureAirbrushDebugScheduledPrewarmRunCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugScheduledPrewarmRunCount) || 0)) + 1
    );
  } else if (label === "skip") {
    root.dataset.textureAirbrushDebugScheduledPrewarmSkipCount = String(
      Math.max(0, Math.floor(Number(root.dataset.textureAirbrushDebugScheduledPrewarmSkipCount) || 0)) + 1
    );
    root.dataset.textureAirbrushDebugScheduledPrewarmSkipReason = String(detail.reason || "");
  }
}

function textureAirbrushViewportPrewarmHit(editor = null, options = {}) {
  if (
    !editor
    || options.skipHitLookup === true
    || typeof editor.texturePaintHitForEvent !== "function"
  ) {
    return null;
  }
  const rect = editor.canvas?.getBoundingClientRect?.();
  if (!rect?.width || !rect?.height) {
    return null;
  }
  const fractions = [
    [0.5, 0.38],
    [0.5, 0.48],
    [0.46, 0.42],
    [0.54, 0.42],
    [0.5, 0.66]
  ];
  for (const [x, y] of fractions) {
    const event = {
      clientX: rect.left + rect.width * x,
      clientY: rect.top + rect.height * y,
      button: 0,
      buttons: 0,
      pointerType: "mouse",
      pressure: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {}
    };
    const hit = editor.texturePaintHitForEvent(event, "airbrush");
    if (hit?.record && hit?.hit) {
      return hit;
    }
  }
  return null;
}

function schedulePrewarmCallback(callback, options = {}) {
  const host = typeof window !== "undefined" ? window : globalThis;
  if (typeof host?.setTimeout !== "function") {
    callback();
    return 0;
  }
  if (options.idle === true && typeof host.requestIdleCallback === "function") {
    return host.requestIdleCallback(callback, { timeout: 120 });
  }
  return host.setTimeout(callback, Math.max(0, Number(options.delay) || 0));
}

function nextPrewarmScheduleSerial(editor = null) {
  if (!editor) {
    return 0;
  }
  editor.textureAirbrushPrewarmScheduleSerial = Math.max(
    0,
    Math.floor(Number(editor.textureAirbrushPrewarmScheduleSerial) || 0)
  ) + 1;
  return editor.textureAirbrushPrewarmScheduleSerial;
}

export function installTextureAirbrushWebGpuPrewarmMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushPaintableMaterials() {
      const paintables = [];
      const records = (this.textureAirbrushRecords?.() || this.paintRecords || []).filter((record) => record?.object);
      for (const record of records) {
        const materials = materialsForRecord(record);
        for (let materialIndex = 0; materialIndex < materials.length; materialIndex += 1) {
          const material = materials[materialIndex];
          if (material && (material.map || material.color)) {
            paintables.push({
              record,
              materialIndex,
              material
            });
          }
        }
      }
      return paintables;
    },

    textureAirbrushFirstPaintableMaterial() {
      return this.textureAirbrushPaintableMaterials?.()[0] || null;
    },

    textureAirbrushPrewarmWebGpu(options = {}) {
      return this.textureAirbrushPrewarm?.(null, null, {
        all: options.all === true,
        force: options.force === true,
        liveDisplayExternalTexture: options.liveDisplayExternalTexture === true,
        allowPrewarmLiveDisplayMaterialSwap: options.allowPrewarmLiveDisplayMaterialSwap === true,
        warmScreenHitIndex: options.warmScreenHitIndex !== false,
        externalSourceUpload: options.externalSourceUpload === true,
        tslSurfacePrewarmAll: options.tslSurfacePrewarmAll === true,
        tslSurfacePrewarmLimit: Number.isFinite(Number(options.tslSurfacePrewarmLimit))
          ? Math.max(1, Math.floor(Number(options.tslSurfacePrewarmLimit)))
          : 1,
        renderCompilePass: options.renderCompilePass === true,
        prewarmPaintablesWithoutHit: options.prewarmPaintablesWithoutHit === true,
        ...options
      }) === true;
    },

    cancelTextureAirbrushScheduledPrewarm() {
      nextPrewarmScheduleSerial(this);
      this.textureAirbrushPendingPrewarmEvent = null;
      this.textureAirbrushPendingPrewarmHit = null;
      this.textureAirbrushPendingPrewarmOptions = null;
      this.textureAirbrushPrewarmPending = false;
      return true;
    },

    scheduleTextureAirbrushPrewarm(event = null, hit = null, options = {}) {
      const force = options.force === true;
      if (!force && this.activeTool !== "airbrush") {
        debugWebGpuScheduledPrewarm("skip", {
          reason: "inactive-tool",
          force,
          activeTool: this.activeTool,
          hasModel: Boolean(this.model),
          pending: this.textureAirbrushPrewarmPending === true,
    all: options.all === true,
    liveDisplayExternalTexture: options.liveDisplayExternalTexture ?? null,
    allowPrewarmLiveDisplayMaterialSwap: options.allowPrewarmLiveDisplayMaterialSwap ?? null
  });
        return false;
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const nextPrewarmOptions = mergeScheduledPrewarmOptions(
        this.textureAirbrushPendingPrewarmOptions,
        options,
        force
      );
      debugWebGpuScheduledPrewarm("schedule", {
        force,
        activeTool: this.activeTool,
        hasModel: Boolean(this.model),
        pending: this.textureAirbrushPrewarmPending === true,
        all: nextPrewarmOptions.all === true,
        liveDisplayExternalTexture: nextPrewarmOptions.liveDisplayExternalTexture ?? null,
        allowPrewarmLiveDisplayMaterialSwap: nextPrewarmOptions.allowPrewarmLiveDisplayMaterialSwap ?? null
      });
      if (this.textureAirbrushPrewarmPending) {
        if (event) {
          this.textureAirbrushPendingPrewarmEvent = { clientX: event.clientX, clientY: event.clientY };
        }
        if (hit) {
          this.textureAirbrushPendingPrewarmHit = hit;
        }
        this.textureAirbrushPendingPrewarmOptions = nextPrewarmOptions;
        return false;
      }
      if (
        !force
        && this.textureAirbrushLastPrewarmAt
        && now - this.textureAirbrushLastPrewarmAt < 180
      ) {
        const deferredDelay = Math.max(
          Number(nextPrewarmOptions.delay) || 0,
          Math.ceil(180 - (now - this.textureAirbrushLastPrewarmAt)) + 16
        );
        nextPrewarmOptions.delay = deferredDelay;
        debugWebGpuScheduledPrewarm("defer", {
          reason: "throttled",
          force,
          activeTool: this.activeTool,
          hasModel: Boolean(this.model),
          pending: false,
          all: nextPrewarmOptions.all === true,
          liveDisplayExternalTexture: nextPrewarmOptions.liveDisplayExternalTexture ?? null,
          allowPrewarmLiveDisplayMaterialSwap: nextPrewarmOptions.allowPrewarmLiveDisplayMaterialSwap ?? null
        });
      }
      this.textureAirbrushPendingPrewarmEvent = event
        ? { clientX: event.clientX, clientY: event.clientY }
        : this.textureAirbrushPendingPrewarmEvent || null;
      this.textureAirbrushPendingPrewarmHit = hit || this.textureAirbrushPendingPrewarmHit || null;
      this.textureAirbrushPendingPrewarmOptions = nextPrewarmOptions;
      this.textureAirbrushPrewarmPending = true;
      const scheduleSerial = nextPrewarmScheduleSerial(this);
      const run = () => {
        if (scheduleSerial !== this.textureAirbrushPrewarmScheduleSerial) {
          debugWebGpuScheduledPrewarm("skip", {
            reason: "superseded",
            force,
            activeTool: this.activeTool,
            hasModel: Boolean(this.model),
            pending: this.textureAirbrushPrewarmPending === true,
            all: nextPrewarmOptions.all === true,
            liveDisplayExternalTexture: nextPrewarmOptions.liveDisplayExternalTexture ?? null,
            allowPrewarmLiveDisplayMaterialSwap: nextPrewarmOptions.allowPrewarmLiveDisplayMaterialSwap ?? null
          });
          return;
        }
        this.textureAirbrushPrewarmPending = false;
        this.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const pendingEvent = this.textureAirbrushPendingPrewarmEvent;
        const pendingHit = this.textureAirbrushPendingPrewarmHit;
        const pendingOptions = this.textureAirbrushPendingPrewarmOptions || { force };
        this.textureAirbrushPendingPrewarmEvent = null;
        this.textureAirbrushPendingPrewarmHit = null;
        this.textureAirbrushPendingPrewarmOptions = null;
        if (
          this.painting === true
          || this.textureAirbrushScreenStrokeHasPendingWork?.() === true
        ) {
          this.textureAirbrushPendingPrewarmEvent = pendingEvent;
          this.textureAirbrushPendingPrewarmHit = pendingHit;
          this.textureAirbrushPendingPrewarmOptions = pendingOptions;
          this.textureAirbrushPrewarmPending = true;
          schedulePrewarmCallback(run, { idle: true, delay: 180 });
          return;
        }
        debugWebGpuScheduledPrewarm("run", {
          force: pendingOptions.force === true,
          activeTool: this.activeTool,
          hasModel: Boolean(this.model),
          pending: false,
          all: pendingOptions.all === true,
          liveDisplayExternalTexture: pendingOptions.liveDisplayExternalTexture ?? null,
          allowPrewarmLiveDisplayMaterialSwap: pendingOptions.allowPrewarmLiveDisplayMaterialSwap ?? null
        });
        this.textureAirbrushPrewarm?.(pendingEvent, pendingHit, pendingOptions);
      };
      const runImmediate = nextPrewarmOptions.allowImmediatePrewarm === true
        && force
        && !event
        && (Number(nextPrewarmOptions.delay) || 0) <= 0
        && nextPrewarmOptions.liveDisplayExternalTexture === true;
      if (runImmediate) {
        run();
      } else if (force || !event) {
        schedulePrewarmCallback(run, { delay: nextPrewarmOptions.delay ?? 0 });
      } else {
        schedulePrewarmCallback(run, { idle: true, delay: 24 });
      }
      return true;
    },

    textureAirbrushPrewarm(event = null, hit = null, options = {}) {
      if (!this.renderer || !this.model || (!options.force && this.activeTool !== "airbrush")) {
        debugWebGpuScheduledPrewarm("skip", {
          reason: !this.renderer ? "renderer-missing" : !this.model ? "model-missing" : "inactive-tool",
          force: options.force === true,
          activeTool: this.activeTool,
          hasModel: Boolean(this.model),
          pending: this.textureAirbrushPrewarmPending === true,
          all: options.all === true,
          liveDisplayExternalTexture: options.liveDisplayExternalTexture ?? null,
          allowPrewarmLiveDisplayMaterialSwap: options.allowPrewarmLiveDisplayMaterialSwap ?? null
        });
        return false;
      }
      debugWebGpuScheduledPrewarm("prewarm", {
        force: options.force === true,
        activeTool: this.activeTool,
        hasModel: Boolean(this.model),
        pending: this.textureAirbrushPrewarmPending === true,
        all: options.all === true,
        liveDisplayExternalTexture: options.liveDisplayExternalTexture ?? null,
        allowPrewarmLiveDisplayMaterialSwap: options.allowPrewarmLiveDisplayMaterialSwap ?? null
      });
      const warmScreenHitIndex = () => {
        if (options.warmScreenHitIndex === false || typeof this.textureAirbrushBuildScreenHitIndex !== "function") {
          return false;
        }
        const rect = this.canvas?.getBoundingClientRect?.();
        return Boolean(rect?.width && rect?.height && this.textureAirbrushBuildScreenHitIndex({ rect }));
      };
      const warmWebGpuStrokeGeometry = () => (
        textureAirbrushPrewarmWebGpuStrokeGeometry(this, options) > 0
      );
      const broadPrewarm = options.all === true;
      const paintHit = broadPrewarm
        ? null
        : hit || (options.skipHitLookup === true
          ? null
          : (event
            ? this.texturePaintHitForEvent?.(event, "airbrush")
            : textureAirbrushViewportPrewarmHit(this, options)));
      const record = paintHit?.record;
      const material = record ? this.clonePaintMaterialForHit?.(record, paintHit.hit) : null;
      const warmNeighborTopology = () => {
        if (
          options.warmNeighborTopology === false
          || this.texturePaintNeighborModeEnabled?.() !== true
          || typeof this.textureAirbrushPrewarmNeighborTopology !== "function"
        ) {
          return false;
        }
        if (record) {
          return this.textureAirbrushPrewarmNeighborTopology(record, options) > 0;
        }
        return this.textureAirbrushPrewarmNeighborTopology(null, {
          ...options,
          limit: options.neighborTopologyLimit ?? (options.all === true ? 12 : 2)
        }) > 0;
      };
      const canPrewarmPaintablesWithoutHit = options.prewarmPaintablesWithoutHit !== false;
      const warmed = !broadPrewarm && record && material
        ? this.textureAirbrushPrewarmWebGpuFromHit?.(paintHit, options) === true
        : (broadPrewarm || canPrewarmPaintablesWithoutHit)
          ? Boolean(this.textureAirbrushPrewarmAllWebGpuPaintables?.(options))
          : false;
      const geometryWarmed = warmWebGpuStrokeGeometry();
      const screenHitIndexWarmed = warmScreenHitIndex();
      const neighborTopologyWarmed = warmNeighborTopology();
      const result = geometryWarmed || screenHitIndexWarmed || neighborTopologyWarmed || warmed;
      if (result) {
        this.textureAirbrushLastPrewarmAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      }
      return result;
    },

    scheduleTextureAirbrushPostStrokePrewarm(stroke = null) {
      const webGpuStrokePrewarmActive = typeof this.textureAirbrushPrewarmWebGpuStrokeSourcesForStroke === "function"
        && webGpuBackendReady(this);
      if (
        this.textureAirbrushPostStrokePrewarmPending
        || !webGpuStrokePrewarmActive
        || textureAirbrushStrokeUsesTslSurfaceTarget(stroke)
      ) {
        return false;
      }
      this.textureAirbrushPostStrokePrewarmPending = true;
      const scheduleSerial = Math.max(
        0,
        Math.floor(Number(this.textureAirbrushPostStrokePrewarmSerial) || 0)
      ) + 1;
      this.textureAirbrushPostStrokePrewarmSerial = scheduleSerial;
      schedulePrewarmCallback(() => {
        if (scheduleSerial !== this.textureAirbrushPostStrokePrewarmSerial) {
          return;
        }
        this.textureAirbrushPostStrokePrewarmPending = false;
        if (
          this.painting === true
          || this.textureAirbrushScreenStrokeHasPendingWork?.()
        ) {
          this.scheduleTextureAirbrushPostStrokePrewarm?.(stroke);
          return;
        }
        this.textureAirbrushPrewarmWebGpuStrokeSourcesForStroke?.(stroke, {
          liveDisplayExternalTexture: true,
          label: "texture-airbrush-post-stroke-prewarm"
        });
      }, { delay: 32 });
      return true;
    },

    cancelTextureAirbrushPostStrokePrewarm() {
      this.textureAirbrushPostStrokePrewarmSerial = Math.max(
        0,
        Math.floor(Number(this.textureAirbrushPostStrokePrewarmSerial) || 0)
      ) + 1;
      this.textureAirbrushPostStrokePrewarmPending = false;
      return true;
    },

    textureAirbrushPrewarmWebGpuEditable(editable = null, material = null, options = {}) {
      const backendReady = webGpuBackendReady(this);
      if (!editable?.canvas || !backendReady) {
        debugWebGpuPrewarm("skip", {
          reason: !editable?.canvas ? "editable-canvas-missing" : "backend-not-ready",
          backendReady,
          hasEditableCanvas: Boolean(editable?.canvas),
          hasMaterial: Boolean(material)
        });
        return null;
      }
      const color = options.color || this.textureAirbrushColor?.() || { r: 255, g: 255, b: 255 };
      const ensureStrokeSourceImageData = options.ensureStrokeSourceImageData === true
        || options.all !== true;
      const result = this.textureAirbrushPrewarmEditableWebGpuPaint?.(editable, {
        radiusPixels: Math.max(1, options.radiusPixels ?? this.textureBrushRadiusScreenPixels?.() ?? 24),
        opacity: options.opacity ?? this.textureAirbrushOpacity?.() ?? 0.42,
        hardness: options.hardness ?? this.textureAirbrushHardness?.() ?? 0.35,
        scatter: options.scatter ?? this.textureAirbrushScatter?.() ?? 0.35,
        color,
        material,
        externalSourceUpload: options.externalSourceUpload !== false && !ensureStrokeSourceImageData,
        // Only airbrush/tool-entry prewarm is allowed to swap the material to
        // the live WebGPU display. Generic source prewarm should keep the
        // visible map untouched.
        liveDisplayExternalTexture: options.liveDisplayExternalTexture === true,
        allowPrewarmLiveDisplayMaterialSwap: options.allowPrewarmLiveDisplayMaterialSwap === true,
        ensureStrokeSourceImageData,
        refreshSource: options.refreshSource === true || options.force === true,
        label: options.label || "texture-airbrush-prewarm"
      });
      debugWebGpuPrewarm(result ? "result" : "skip", {
        reason: result ? "" : "prewarm-result-empty",
        backendReady,
        hasEditableCanvas: true,
        hasMaterial: Boolean(material),
        warmed: Boolean(result),
        liveDisplayExternalTexture: result?.stats?.liveDisplayExternalTexture ?? null,
        allowPrewarmLiveDisplayMaterialSwap: options.allowPrewarmLiveDisplayMaterialSwap ?? null,
        liveDisplayFullUpdate: result?.stats?.liveDisplayFullUpdate ?? null,
        liveDisplayWorkPixels: result?.stats?.liveDisplayWorkPixels ?? null
      });
      return result;
    },

    textureAirbrushPrewarmWebGpuFromHit(paintHit = null, options = {}) {
      if (!webGpuBackendReady(this)) {
        return false;
      }
      const record = paintHit?.record || null;
      const material = record ? this.clonePaintMaterialForHit?.(record, paintHit.hit) : null;
      const editable = material ? this.editableClonePaintTexture?.(material) : null;
      let warmed = false;
      const prewarmTslSurface = options.tslSurfacePrewarmHit === true
        || options.tslSurfacePrewarmAll === true;
      for (const variant of editablePrewarmVariants(material, editable)) {
        warmed = Boolean(this.textureAirbrushPrewarmWebGpuEditable?.(variant, material, options)) || warmed;
        if (prewarmTslSurface) {
          const tslCandidate = tslSurfacePrewarmCandidate(
            record,
            paintHit?.hit || null,
            material,
            variant,
            paintHit?.hit?.face?.materialIndex
          );
          warmed = Boolean(texturePaintPrewarmTslSurfaceAirbrush(this, tslCandidate, options)) || warmed;
        }
      }
      return warmed;
    },

    textureAirbrushPrewarmFirstWebGpuPaintable(options = {}) {
      if (!webGpuBackendReady(this)) {
        return false;
      }
      const paintables = textureAirbrushPrewarmPaintables(this, options);
      for (const paintable of paintables) {
        const record = paintable.record || null;
        const material = paintable.material || paintableMaterialFromRecord(this, record);
        const editable = material ? this.editableClonePaintTexture?.(material) : null;
        let warmed = false;
        for (const variant of editablePrewarmVariants(material, editable)) {
          warmed = Boolean(this.textureAirbrushPrewarmWebGpuEditable?.(variant, material, options)) || warmed;
          if (options.tslSurfacePrewarmAll === true) {
            const materialIndex = Number.isFinite(Number(paintable.materialIndex))
              ? Number(paintable.materialIndex)
              : materialsForRecord(record).findIndex((entry) => entry === material);
            const tslCandidate = tslSurfacePrewarmCandidate(
              record,
              null,
              material,
              variant,
              materialIndex >= 0 ? materialIndex : null
            );
            warmed = Boolean(texturePaintPrewarmTslSurfaceAirbrush(this, tslCandidate, options)) || warmed;
          }
        }
        if (warmed) {
          return true;
        }
      }
      return false;
    },

    textureAirbrushPrewarmAllWebGpuPaintables(options = {}) {
      if (!webGpuBackendReady(this)) {
        debugWebGpuPrewarm("skip", {
          reason: "backend-not-ready",
          backendReady: false,
          hasEditableCanvas: null,
          hasMaterial: null
        });
        return false;
      }
      const paintables = textureAirbrushPrewarmPaintables(this, options);
      const limit = Math.max(1, Number(options.limit) || 12);
      const tslSurfaceLimit = options.tslSurfacePrewarmAll === true
        ? Math.max(0, Math.floor(Number(options.tslSurfacePrewarmLimit) || 1))
        : 0;
      let tslSurfaceWarmed = 0;
      let warmed = 0;
      for (const paintable of paintables.slice(0, limit)) {
        const editable = paintable.material ? this.editableClonePaintTexture?.(paintable.material) : null;
        let materialWarmed = false;
        for (const variant of editablePrewarmVariants(paintable.material, editable)) {
          materialWarmed = Boolean(this.textureAirbrushPrewarmWebGpuEditable?.(variant, paintable.material, options))
            || materialWarmed;
          if (tslSurfaceWarmed < tslSurfaceLimit) {
            const tslCandidate = tslSurfacePrewarmCandidate(
              paintable.record,
              null,
              paintable.material,
              variant,
              paintable.materialIndex
            );
            const tslWarmed = texturePaintPrewarmTslSurfaceAirbrush(this, tslCandidate, options);
            if (tslWarmed) {
              tslSurfaceWarmed += 1;
            }
            materialWarmed = Boolean(tslWarmed) || materialWarmed;
          }
        }
        if (materialWarmed) {
          warmed += 1;
        }
      }
      debugWebGpuPrewarm("all", {
        backendReady: true,
        paintableCount: paintables.length,
        warmed
      });
      if (warmed || paintables.length) {
        return warmed;
      }
      return this.textureAirbrushPrewarmFirstWebGpuPaintable?.(options) ? 1 : 0;
    },

    textureAirbrushPrewarmWebGpuStrokeSourcesForStroke(stroke = null, options = {}) {
      if (!webGpuBackendReady(this) || !stroke?.before?.length) {
        return 0;
      }
      const seen = new Set();
      let warmed = 0;
      const entries = stroke.before.filter((entry) => (
        entry?.type === "canvas"
        && entry.material
        && entry.canvas
      ));
      for (const entry of entries) {
        if (seen.has(entry.material)) {
          continue;
        }
        seen.add(entry.material);
        const editable = this.editableClonePaintTexture?.(entry.material);
        if (!editable?.canvas) {
          continue;
        }
        const result = this.textureAirbrushPrewarmWebGpuEditable?.(editable, entry.material, {
          ...options,
          externalSourceUpload: options.externalSourceUpload !== false,
          liveDisplayExternalTexture: options.liveDisplayExternalTexture === true,
          label: options.label || "texture-airbrush-post-stroke-prewarm"
        });
        if (result) {
          warmed += 1;
        }
      }
      return warmed;
    }
  });
}
