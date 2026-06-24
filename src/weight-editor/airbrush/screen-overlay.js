import {
  TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD,
  airbrushAlphaForDistance,
  airbrushHaloRadius,
  clampByte,
  distanceToSegmentPixels
} from "./math.js";

export function installTextureAirbrushScreenOverlayMethods(BirdWeightEditor) {
  Object.assign(BirdWeightEditor.prototype, {
    resizeTextureAirbrushScreenLayer() {
      const layer = this.textureAirbrushScreenLayer;
      if (!layer || !this.canvas) {
        return null;
      }
      const rect = this.canvas.getBoundingClientRect();
      const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      if (layer.width !== width || layer.height !== height) {
        layer.width = width;
        layer.height = height;
      }
      return {
        layer,
        context: layer.getContext("2d"),
        rect,
        scale
      };
    },

    captureTextureAirbrushScreenBase(layerState = null) {
      const state = layerState || this.resizeTextureAirbrushScreenLayer?.();
      if (!state?.layer || !this.canvas) {
        this.textureAirbrushScreenBaseImage = null;
        return null;
      }
      const { layer } = state;
      const baseCanvas = this.textureAirbrushScreenBaseCanvas || document.createElement("canvas");
      if (baseCanvas.width !== layer.width || baseCanvas.height !== layer.height) {
        baseCanvas.width = layer.width;
        baseCanvas.height = layer.height;
      }
      const context = baseCanvas.getContext("2d");
      if (!context) {
        this.textureAirbrushScreenBaseImage = null;
        return null;
      }
      try {
        context.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        context.drawImage(this.canvas, 0, 0, baseCanvas.width, baseCanvas.height);
        this.textureAirbrushScreenBaseCanvas = baseCanvas;
        this.textureAirbrushScreenBaseContext = context;
        this.textureAirbrushScreenBaseImage = context.getImageData(0, 0, baseCanvas.width, baseCanvas.height);
      } catch {
        this.textureAirbrushScreenBaseImage = null;
      }
      return this.textureAirbrushScreenBaseImage;
    },

    clearTextureAirbrushScreenLayer(options = {}) {
      const layer = this.textureAirbrushScreenLayer;
      if (!layer) {
        return;
      }
      if (options.defer) {
        const token = {};
        this.textureAirbrushScreenClearToken = token;
        const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame.bind(window)
          : (callback) => window.setTimeout(callback, 16);
        requestFrame(() => {
          requestFrame(() => {
            if (this.textureAirbrushScreenClearToken === token) {
              this.textureAirbrushScreenClearToken = null;
              this.clearTextureAirbrushScreenLayer?.();
            }
          });
        });
        return;
      }
      const context = layer.getContext("2d");
      context?.clearRect(0, 0, layer.width || 0, layer.height || 0);
      layer.hidden = true;
      this.textureAirbrushScreenBaseImage = null;
    },

    drawTextureAirbrushScreenStrokePreview(payload) {
      const layerState = this.resizeTextureAirbrushScreenLayer?.();
      const context = layerState?.context;
      if (!payload || !context || !layerState?.rect) {
        return false;
      }
      const { layer, rect, scale } = layerState;
      const startX = (payload.strokeStart.clientX - rect.left) * scale;
      const startY = (payload.strokeStart.clientY - rect.top) * scale;
      const endX = (payload.clientX - rect.left) * scale;
      const endY = (payload.clientY - rect.top) * scale;
      const color = payload.color || this.textureAirbrushColor();
      const radius = Math.max(1, payload.radiusPixels || 1) * scale;
      const opacity = Math.max(0.04, Math.min(0.9, Number(payload.opacity ?? 0.42)));
      this.textureAirbrushScreenClearToken = null;
      layer.hidden = false;
      context.save();
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = opacity;
      context.strokeStyle = `rgb(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)})`;
      context.fillStyle = context.strokeStyle;
      context.lineWidth = Math.max(1, radius * 2);
      context.lineCap = "round";
      context.lineJoin = "round";
      const dx = endX - startX;
      const dy = endY - startY;
      if (dx * dx + dy * dy <= 0.25) {
        context.beginPath();
        context.arc(endX, endY, radius, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(endX, endY);
        context.stroke();
      }
      context.restore();
      return true;
    },

    drawTextureAirbrushScreenStroke(payload) {
      const layerState = this.resizeTextureAirbrushScreenLayer?.();
      const context = layerState?.context;
      if (!payload || !context || !layerState?.rect) {
        return false;
      }
      const { layer, rect, scale } = layerState;
      const startX = payload.strokeStart.clientX - rect.left;
      const startY = payload.strokeStart.clientY - rect.top;
      const endX = payload.clientX - rect.left;
      const endY = payload.clientY - rect.top;
      const color = payload.color || this.textureAirbrushColor();
      const red = clampByte(color.r);
      const green = clampByte(color.g);
      const blue = clampByte(color.b);
      const opacity = Math.max(0.001, Math.min(1, Number(payload.opacity ?? 0.42)));
      const hardness = Math.max(0, Math.min(1, Number(payload.hardness ?? 0.35)));
      const scatter = Math.max(0, Math.min(1, Number(payload.scatter ?? 0.35)));
      const strength = Math.max(0.08, Math.min(1, Number(payload.strength ?? 1)));
      const radius = Math.max(1, payload.radiusPixels);
      const haloRadius = airbrushHaloRadius(radius, scatter);
      const minX = Math.max(0, Math.floor((Math.min(startX, endX) - haloRadius - 2) * scale));
      const maxX = Math.min(layer.width, Math.ceil((Math.max(startX, endX) + haloRadius + 2) * scale));
      const minY = Math.max(0, Math.floor((Math.min(startY, endY) - haloRadius - 2) * scale));
      const maxY = Math.min(layer.height, Math.ceil((Math.max(startY, endY) + haloRadius + 2) * scale));
      const width = maxX - minX;
      const height = maxY - minY;
      if (width <= 0 || height <= 0) {
        return false;
      }
      this.textureAirbrushScreenClearToken = null;
      layer.hidden = false;

      const image = context.getImageData(minX, minY, width, height);
      const data = image.data;
      for (let y = 0; y < height; y += 1) {
        const screenY = (minY + y + 0.5) / scale;
        for (let x = 0; x < width; x += 1) {
          const screenX = (minX + x + 0.5) / scale;
          const distance = distanceToSegmentPixels(screenX, screenY, startX, startY, endX, endY);
          const alpha = airbrushAlphaForDistance(distance, radius, opacity, scatter, hardness, strength);
          if (alpha <= TEXTURE_AIRBRUSH_ALPHA_DISCARD_THRESHOLD) {
            continue;
          }
          const offset = (y * width + x) * 4;
          const alphaByte = clampByte(alpha * 255);
          if (alphaByte <= data[offset + 3]) {
            continue;
          }
          data[offset] = red;
          data[offset + 1] = green;
          data[offset + 2] = blue;
          data[offset + 3] = alphaByte;
        }
      }
      context.putImageData(image, minX, minY);
      return true;
    }
  });
}
