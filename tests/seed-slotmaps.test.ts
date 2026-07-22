import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { seedSlotmap, SLOT_SEED } from '../tools/seed-slotmaps';
import { readSlotmap, SLOTS } from '../src/domain/slots';

const WIZARD = 'assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/oryx_16bit_fantasy_creatures_04.png';

describe('seedSlotmap', () => {
  it('labels the wizard robe as body and separates the eyes into their own slot', () => {
    const map = readSlotmap(seedSlotmap(readFileSync(WIZARD), SLOT_SEED.wizard));
    const bodyPixels = Array.from(map).filter((s) => s === SLOTS.body).length;
    const eyePixels = Array.from(map).filter((s) => s === SLOTS.flair).length;
    expect(bodyPixels).toBeGreaterThan(30); // the robe is labeled body
    expect(eyePixels).toBeGreaterThan(0);   // the eyes are carved out into flair, not body
  });
});
