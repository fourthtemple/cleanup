function clampPressure(value = 1) {
  return Math.max(0.02, Math.min(1, Number(value)));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rawEventPressure(event = null) {
  const pressure = finiteNumber(event?.pressure);
  const vendorPressure = vendorEventPressure(event);
  if (vendorPressure !== null && vendorPressure > 0 && (pressure === null || pressure <= 0 || pressure === 0.5)) {
    return vendorPressure;
  }
  return pressure ?? vendorPressure;
}

function vendorEventPressure(event = null) {
  return finiteNumber(event?.webkitPressure)
    ?? finiteNumber(event?.mozPressure);
}

function pointerEventPressureSource(event = null) {
  return String(event?.type || "").toLowerCase().startsWith("pointer");
}

function pressureValueLooksStylusLike(pressure = null, event = null) {
  if (pressure === null || pressure <= 0) {
    return false;
  }
  const pointerType = String(event?.pointerType || "").toLowerCase();
  if (pointerType === "pen" || pointerType === "touch") {
    return true;
  }
  return pressure !== 0.5;
}

function webKitForceConstant(event = null, name = "") {
  return finiteNumber(event?.[name])
    ?? finiteNumber(event?.constructor?.[name])
    ?? finiteNumber(globalThis.MouseEvent?.[name]);
}

function webKitForceEventType(event = null) {
  return String(event?.type || "").toLowerCase().startsWith("webkitmouseforce");
}

function webKitForceTouchPressure(event = null, force = null) {
  if (!webKitForceEventType(event) || force === null || force <= 0) {
    return null;
  }
  if (force > 0 && force < 1) {
    return clampPressure(force);
  }
  const mouseDownForce = webKitForceConstant(event, "WEBKIT_FORCE_AT_MOUSE_DOWN") ?? 1;
  const forceClickForce = webKitForceConstant(event, "WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN") ?? 3;
  if (forceClickForce > mouseDownForce) {
    return clampPressure((force - mouseDownForce) / (forceClickForce - mouseDownForce));
  }
  return clampPressure(force > 1 ? (force - 1) / 2 : force);
}

function retainedPressureSource(event = null) {
  const source = String(event?.__cleanupPressureSource || "");
  return source === "native" ? source : "";
}

export function textureAirbrushWebKitForcePressure(event = null) {
  const force = finiteNumber(event?.webkitForce ?? event?.force);
  if (force === null || force <= 0) {
    return null;
  }
  const forceTouchPressure = webKitForceTouchPressure(event, force);
  if (forceTouchPressure !== null) {
    return forceTouchPressure;
  }
  const pointerType = String(event?.pointerType || "").toLowerCase();
  const pressurePointer = pointerType === "pen" || pointerType === "touch";
  if (pressurePointer && force <= 1) {
    return clampPressure(force);
  }

  const mouseDownForce = webKitForceConstant(event, "WEBKIT_FORCE_AT_MOUSE_DOWN");
  const forceClickForce = webKitForceConstant(event, "WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN");
  if (forceClickForce !== null && forceClickForce > 0) {
    if (!pressurePointer && mouseDownForce !== null && force < mouseDownForce) {
      return clampPressure(force);
    }
    if (!pressurePointer && mouseDownForce !== null && force <= mouseDownForce) {
      return null;
    }
    if (!pressurePointer && mouseDownForce !== null && forceClickForce > mouseDownForce) {
      return clampPressure((force - mouseDownForce) / (forceClickForce - mouseDownForce));
    }
    return clampPressure(force / forceClickForce);
  }
  if (!pointerType && force <= 1) {
    return clampPressure(force);
  }
  if (pressurePointer) {
    return clampPressure(force > 1 ? (force - 1) / 2 : force);
  }
  return force > 1 ? clampPressure((force - 1) / 2) : null;
}

export function textureAirbrushPressurePointerType(event = null) {
  const pointerType = String(event?.pointerType || "").toLowerCase();
  if (pointerType === "pen" || pointerType === "touch") {
    return true;
  }
  const pressure = rawEventPressure(event);
  const vendorPressure = vendorEventPressure(event);
  if (vendorPressure !== null && vendorPressure > 0) {
    return true;
  }
  if (pressureValueLooksStylusLike(pressure, event)) {
    return true;
  }
  return textureAirbrushWebKitForcePressure(event) !== null;
}

export function textureAirbrushEventPressureValue(event = null, options = {}) {
  if (Number.isFinite(Number(options.pressure))) {
    return clampPressure(options.pressure);
  }
  const pointerType = String(event?.pointerType || "").toLowerCase();
  const rawPressure = rawEventPressure(event);
  const webKitPressure = textureAirbrushWebKitForcePressure(event);
  const pressurePointer = textureAirbrushPressurePointerType(event);

  if (pressurePointer && webKitPressure !== null && (rawPressure === null || rawPressure <= 0 || rawPressure === 0.5)) {
    return webKitPressure;
  }
  if (rawPressure === null) {
    return webKitPressure;
  }
  if (pointerType && pointerType !== "pen" && pointerType !== "touch") {
    return pressureValueLooksStylusLike(rawPressure, event)
      ? clampPressure(rawPressure)
      : webKitPressure;
  }
  if (!pointerType && (rawPressure <= 0 || (rawPressure === 0.5 && !pointerEventPressureSource(event)))) {
    return webKitPressure;
  }
  if (rawPressure <= 0) {
    return pointerType === "pen" || pointerType === "touch" ? 0.02 : webKitPressure;
  }
  return clampPressure(rawPressure);
}

export function textureAirbrushEventHasNativePressure(event = null) {
  return textureAirbrushEventPressureValue(event) !== null;
}

export function installTextureAirbrushPressureMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    textureAirbrushPressureSettings(options = {}) {
      return {
        radius: options.pressureRadius ?? Boolean(this.texturePressureRadius?.checked),
        opacity: options.pressureOpacity ?? Boolean(this.texturePressureOpacity?.checked),
        hardness: options.pressureHardness ?? Boolean(this.texturePressureHardness?.checked),
        scatter: options.pressureScatter ?? Boolean(this.texturePressureScatter?.checked)
      };
    },

    textureAirbrushPressureValue(event = null, options = {}) {
      return this.textureAirbrushPressureDetails?.(event, options).pressure ?? 1;
    },

    textureAirbrushPressureDetails(event = null, options = {}) {
      if (Number.isFinite(Number(options.pressure))) {
        this.textureAirbrushLastPressureSource = options.pressureSource || "option";
        return {
          pressure: clampPressure(options.pressure),
          source: this.textureAirbrushLastPressureSource
        };
      }
      const retainedSource = retainedPressureSource(event);
      if (retainedSource) {
        const retainedPressure = textureAirbrushEventPressureValue(event, options);
        if (retainedPressure !== null) {
          this.textureAirbrushLastPressureSource = retainedSource;
          return {
            pressure: retainedPressure,
            source: retainedSource
          };
        }
      }
      const nativePressure = textureAirbrushEventPressureValue(event, options);
      if (nativePressure !== null) {
        this.textureAirbrushLastPressureSource = "native";
        return {
          pressure: nativePressure,
          source: "native"
        };
      }
      this.textureAirbrushLastPressureSource = "default";
      return {
        pressure: 1,
        source: "default"
      };
    },

    textureAirbrushPressureInputActive(event = null, options = {}) {
      return textureAirbrushPressurePointerType(event);
    },

    textureAirbrushOptionsWithPressure(event = null, options = {}) {
      if (options.pressureApplied) {
        return options;
      }
      const settings = this.textureAirbrushPressureSettings?.(options) || {};
      const pressureDetails = this.textureAirbrushPressureDetails?.(event, options) || {};
      const pressure = pressureDetails.pressure ?? 1;
      const pressureScale = Math.max(0.02, Math.min(1, pressure));
      const next = {
        ...options,
        pressure,
        pressureSource: pressureDetails.source || "default",
        pressureRadius: settings.radius,
        pressureOpacity: settings.opacity,
        pressureHardness: settings.hardness,
        pressureScatter: settings.scatter,
        pressureApplied: true
      };
      if (settings.radius) {
        const baseRadius = Number.isFinite(Number(options.radiusPixels))
          ? Number(options.radiusPixels)
          : this.textureBrushRadiusScreenPixels?.() || 24;
        next.radiusPixels = Math.max(0.75, baseRadius * pressureScale);
      }
      if (settings.opacity) {
        const baseOpacity = Number.isFinite(Number(options.opacity))
          ? Number(options.opacity)
          : this.textureAirbrushOpacity?.() ?? 0.42;
        next.opacity = Math.max(0.001, Math.min(1, baseOpacity * pressureScale));
      }
      if (settings.hardness) {
        const baseHardness = Number.isFinite(Number(options.hardness))
          ? Number(options.hardness)
          : this.textureAirbrushHardness?.() ?? 0.35;
        next.hardness = Math.max(0, Math.min(1, baseHardness * pressureScale));
      }
      if (settings.scatter) {
        const baseScatter = Number.isFinite(Number(options.scatter))
          ? Number(options.scatter)
          : this.textureAirbrushScatter?.() ?? 0.35;
        next.scatter = Math.max(0, Math.min(1, baseScatter * pressureScale));
      }
      return next;
    }
  });
}
