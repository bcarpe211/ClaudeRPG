import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  TILE_MANIFEST, DEFAULT_THEME, themeTiles, worldSpriteUrl,
} from '../src/domain/tilemanifest';

const SLICED = 'assets/oryx_16-bit_fantasy_1.1/Sliced/world_24x24';

describe('tile manifest', () => {
  it('defines the three themes used by the engine', () => {
    for (const t of ['stone_crypt', 'cave', 'wood_fort']) {
      expect(TILE_MANIFEST[t]).toBeDefined();
    }
    expect(TILE_MANIFEST[DEFAULT_THEME]).toBeDefined();
  });

  it('each theme has wall, floor, door, floorVariants and decor', () => {
    for (const [name, t] of Object.entries(TILE_MANIFEST)) {
      expect(t.wall, `${name}.wall`).toBeTruthy();
      expect(t.floor, `${name}.floor`).toBeTruthy();
      expect(t.door, `${name}.door`).toBeTruthy();
      expect(t.floorVariants.length, `${name}.floorVariants`).toBeGreaterThanOrEqual(1);
      expect(t.decor.length, `${name}.decor`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every referenced sprite file actually exists on disk', () => {
    for (const [name, t] of Object.entries(TILE_MANIFEST)) {
      const all = [t.wall, t.floor, t.door, ...(t.wallVariants ?? []),
        ...t.floorVariants, ...t.decor];
      for (const f of all) {
        expect(existsSync(path.join(SLICED, f)), `${name}: ${f}`).toBe(true);
      }
    }
  });

  it('themeTiles falls back to the default for unknown themes', () => {
    expect(themeTiles('does_not_exist')).toBe(TILE_MANIFEST[DEFAULT_THEME]);
    expect(themeTiles('cave')).toBe(TILE_MANIFEST['cave']);
  });

  it('worldSpriteUrl points at the static sprite mount', () => {
    expect(worldSpriteUrl('oryx_16bit_fantasy_world_100.png'))
      .toBe('/sprites/world_24x24/oryx_16bit_fantasy_world_100.png');
  });
});
