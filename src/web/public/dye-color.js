'use strict';

(function exposeDyeColor(root) {
  function hsvToRgb(hueDegrees, saturation, value) {
    const hue = (((hueDegrees % 360) + 360) % 360) / 360;
    const index = Math.floor(hue * 6);
    const fraction = hue * 6 - index;
    const p = value * (1 - saturation);
    const q = value * (1 - fraction * saturation);
    const t = value * (1 - (1 - fraction) * saturation);
    return [
      [value, t, p], [q, value, p], [p, value, t],
      [p, q, value], [t, p, value], [value, p, q],
    ][index % 6].map((channel) => Math.round(channel * 255));
  }

  function toneColorize(red, green, blue, hue, saturation, tone) {
    const sourceValue = Math.max(red, green, blue) / 255;
    const t = Math.max(-1, Math.min(1, Number.isFinite(tone) ? tone : 0));
    const amount = Math.abs(t);
    const outputSaturation = saturation + (0 - saturation) * amount;
    const targetValue = t <= 0 ? 0.32 * sourceValue : 0.74 + 0.26 * sourceValue;
    const outputValue = sourceValue + (targetValue - sourceValue) * amount;
    return hsvToRgb(hue, outputSaturation, outputValue);
  }

  function applyRule(rule, red, green, blue) {
    const value = Math.max(red, green, blue) / 255;
    if (rule.op === 'value') {
      const lo = rule.lo == null ? 0 : rule.lo;
      const hi = rule.hi == null ? 1 : rule.hi;
      const channel = Math.round((lo + value * (hi - lo)) * 255);
      return [channel, channel, channel];
    }
    if (rule.op === 'colorize') {
      return toneColorize(
        red, green, blue,
        rule.hue == null ? 0 : rule.hue,
        rule.sat == null ? 0.6 : rule.sat,
        rule.tone == null ? 0 : rule.tone,
      );
    }
    const min = Math.min(red, green, blue) / 255;
    const saturation = value === 0 ? 0 : (value - min) / value;
    return hsvToRgb(rule.hue == null ? 0 : rule.hue, saturation, value);
  }

  root.ClaudeRpgDyeColor = Object.freeze({ hsvToRgb, toneColorize, applyRule }); // runtime-raiders-copy-allow -- compatibility global
})(globalThis);
