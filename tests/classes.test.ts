import { describe, it, expect } from 'vitest';
import {
  CLASSES,
  getClass,
  spriteIndexFor,
  creatureSpriteFile,
} from '../src/domain/classes';

describe('classes', () => {
  it('has the 9 documented hero classes', () => {
    expect(CLASSES.length).toBe(9);
    expect(CLASSES.map((c) => c.key)).toContain('paladin');
  });

  it('maps gender to the correct creature_key index', () => {
    expect(spriteIndexFor('knight', 'M')).toBe(1);
    expect(spriteIndexFor('knight', 'F')).toBe(10);
    expect(spriteIndexFor('paladin', 'M')).toBe(9);
    expect(spriteIndexFor('paladin', 'F')).toBe(18);
  });

  it('builds zero-padded sprite filenames', () => {
    expect(creatureSpriteFile(1)).toBe('oryx_16bit_fantasy_creatures_01.png');
    expect(creatureSpriteFile(18)).toBe('oryx_16bit_fantasy_creatures_18.png');
    expect(creatureSpriteFile(100)).toBe('oryx_16bit_fantasy_creatures_100.png');
  });

  it('getClass returns undefined for unknown key', () => {
    expect(getClass('dragonrider')).toBeUndefined();
  });
});
