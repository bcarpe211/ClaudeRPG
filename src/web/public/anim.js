// Portable two-frame sprite animation for ClaudeRPG.
// creatures_24x24 is a 22x18 sheet of A/B animation pairs: a frame-A sprite at
// file index N has its animation partner at N+18 (the next row). Frame A = odd
// rows. This module carries that math (renderer-agnostic — used by the catalog
// now and the TV dungeon view later) plus a DOM flip helper for <img> pages.
// No imports and no DOM access at module scope, so it is safe to import in Node
// (server / unit tests); DOM is only touched inside start().
const ROW = 18;

/** True if the 1-based file index is a frame-A sprite (odd sheet row). */
export function isFrameA(fileIndex) {
  return Math.floor((fileIndex - 1) / ROW) % 2 === 0;
}

/** Animation partner file index: +ROW for a frame-A file, -ROW for a frame-B file. */
export function framePartner(fileIndex) {
  return isFrameA(fileIndex) ? fileIndex + ROW : fileIndex - ROW;
}

/** Which frame (0 or 1) to show at time nowMs given a flip period. */
export function frameAt(nowMs, periodMs) {
  return Math.floor(nowMs / periodMs) % 2;
}

/**
 * Start a shared-clock flip. Every element with class `sprite-anim` holds a
 * `.frame-a` and a `.frame-b` child; on each tick the container toggles the
 * `show-b` class so the whole page flips in sync. One timer drives everything.
 */
export function start(opts) {
  const periodMs = (opts && opts.periodMs) || 1000;
  const tick = () => {
    const showB = frameAt(Date.now(), periodMs) === 1;
    document.querySelectorAll('.sprite-anim').forEach((el) => {
      el.classList.toggle('show-b', showB);
    });
  };
  tick();
  setInterval(tick, periodMs);
}
