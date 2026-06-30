import { describe, it, expect } from 'vitest';
import { isFrameA, framePartner, frameAt } from '../src/web/public/anim.js';

describe('isFrameA', () => {
  it('odd sheet rows (frame A) vs even rows (frame B)', () => {
    expect(isFrameA(1)).toBe(true);    // row 1
    expect(isFrameA(18)).toBe(true);   // row 1
    expect(isFrameA(19)).toBe(false);  // row 2 (B)
    expect(isFrameA(37)).toBe(true);   // row 3 (A)
    expect(isFrameA(55)).toBe(false);  // row 4 (B)
    expect(isFrameA(217)).toBe(true);  // row 13 (A)
  });
});

describe('framePartner', () => {
  it('pairs frame A with +18 and frame B with -18', () => {
    expect(framePartner(1)).toBe(19);
    expect(framePartner(19)).toBe(1);
    expect(framePartner(37)).toBe(55);
    expect(framePartner(55)).toBe(37);
    expect(framePartner(217)).toBe(235);
  });
});

describe('frameAt', () => {
  it('toggles 0/1 across each period boundary', () => {
    expect(frameAt(0, 1000)).toBe(0);
    expect(frameAt(999, 1000)).toBe(0);
    expect(frameAt(1000, 1000)).toBe(1);
    expect(frameAt(1999, 1000)).toBe(1);
    expect(frameAt(2000, 1000)).toBe(0);
  });
});
