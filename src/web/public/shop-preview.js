'use strict';

(function exposeShopPreview(root) {
  const palettes = [
    [8, 142, 218],
    [286, 38, 176],
    [52, 194, 326],
  ];
  const durations = [5300, 6100, 7100, 7900, 8900];

  function hueAt(timeMs, demoIndex) {
    const palette = palettes[demoIndex % palettes.length];
    const duration = durations[demoIndex % durations.length];
    const phase = (demoIndex * 0.271) % 1;
    const cycle = (((timeMs / duration) + phase) % 1 + 1) % 1;
    const scaled = cycle * palette.length;
    const segment = Math.floor(scaled);
    const progress = scaled - segment;
    const eased = progress * progress * (3 - 2 * progress);
    const from = palette[segment % palette.length];
    const to = palette[(segment + 1) % palette.length];
    const delta = ((to - from + 540) % 360) - 180;
    return ((from + delta * eased) % 360 + 360) % 360;
  }

  function demoRuleFor(slot, demoSlots, savedConfig, timeMs) {
    const demoIndex = demoSlots.indexOf(slot);
    if (demoIndex >= 0) {
      return { op: 'colorize', hue: hueAt(timeMs, demoIndex), sat: 0.6, tone: 0 };
    }
    return Object.prototype.hasOwnProperty.call(savedConfig, slot)
      ? savedConfig[slot]
      : null;
  }

  root.ClaudeRpgShopPreview = Object.freeze({ hueAt, demoRuleFor }); // runtime-raiders-copy-allow -- compatibility global

  const preview = root.__SHOP_PREVIEW__;
  const colorMath = root.ClaudeRpgDyeColor; // runtime-raiders-copy-allow -- compatibility global
  const documentRef = root.document;
  if (!preview || !colorMath || !documentRef || typeof root.requestAnimationFrame !== 'function') {
    return;
  }

  const canvas = documentRef.getElementById('shop-preview');
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  context.imageSmoothingEnabled = false;
  const reducedMotion = typeof root.matchMedia === 'function'
    && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const frameStates = {};
  for (const frame of ['a', 'b']) {
    const sourceCanvas = documentRef.createElement('canvas');
    sourceCanvas.width = 24;
    sourceCanvas.height = 24;
    const sourceContext = sourceCanvas.getContext('2d');
    if (!sourceContext) return;
    sourceContext.imageSmoothingEnabled = false;
    const image = new root.Image();
    frameStates[frame] = {
      image,
      sourceContext,
      sourcePixels: null,
      slotmap: preview.frames[frame].slotmap,
    };
    image.onload = function () {
      sourceContext.clearRect(0, 0, 24, 24);
      sourceContext.drawImage(image, 0, 0, 24, 24);
      frameStates[frame].sourcePixels = sourceContext.getImageData(0, 0, 24, 24);
      if (reducedMotion && frame === 'a') render(0);
    };
    image.crossOrigin = 'anonymous';
    image.src = preview.frames[frame].base;
  }

  function render(timeMs) {
    const frame = Math.floor(timeMs / 700) % 2 === 0 ? 'a' : 'b';
    const state = frameStates[frame];
    if (!state.sourcePixels) return;
    const output = context.createImageData(24, 24);
    const source = state.sourcePixels.data;
    const pixels = output.data;
    const pixelCount = Math.min(state.slotmap.length, 24 * 24);

    for (let pixel = 0; pixel < 24 * 24; pixel += 1) {
      const offset = pixel * 4;
      pixels[offset] = source[offset];
      pixels[offset + 1] = source[offset + 1];
      pixels[offset + 2] = source[offset + 2];
      pixels[offset + 3] = source[offset + 3];
      if (pixel >= pixelCount || source[offset + 3] === 0) continue;

      const rule = demoRuleFor(
        state.slotmap[pixel],
        preview.demoSlots,
        preview.config,
        timeMs,
      );
      if (!rule) continue;
      const color = colorMath.applyRule(
        rule,
        source[offset],
        source[offset + 1],
        source[offset + 2],
      );
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }

    context.putImageData(output, 0, 0);
  }

  if (reducedMotion) return;

  const minimumFrameTime = 1000 / 12;
  let lastPaint = Number.NEGATIVE_INFINITY;
  function tick(timeMs) {
    if (timeMs - lastPaint >= minimumFrameTime) {
      render(timeMs);
      lastPaint = timeMs;
    }
    root.requestAnimationFrame(tick);
  }
  root.requestAnimationFrame(tick);
})(globalThis);
