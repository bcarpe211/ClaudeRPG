import { describe, expect, it } from 'vitest';
import { CLASSES } from '../src/domain/classes';
import {
  COSMETIC_CHANNELS,
  channelFor,
  channelsFor,
  entitledChannelsFor,
  lockedChannelsFor,
} from '../src/domain/cosmetic-entitlements';

function labelsByTier(classKey: string, gender: 'M' | 'F') {
  return Object.fromEntries([1, 2, 3].map((tier) => [
    tier,
    channelsFor(classKey, gender)
      .filter((channel) => channel.requiredTier === tier)
      .map((channel) => channel.label),
  ]));
}

describe('COSMETIC_CHANNELS', () => {
  it('preserves the approved male matrix exactly', () => {
    expect(Object.fromEntries(CLASSES.map(({ key }) => [key, labelsByTier(key, 'M')]))).toEqual({
      knight: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Belt', 'Cape', 'Boots', 'Plume'], 3: ['Weapon', 'Shield'] },
      thief: { 1: ['Clothing', 'Cape', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Boots', 'Feather'], 3: ['Weapon', 'Accessory'] },
      ranger: { 1: ['Clothing', 'Cloak', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Boots', 'Feather'], 3: ['Weapon', 'Quiver'] },
      wizard: { 1: ['Clothing', 'Cloak', 'Skin'], 2: ['Gold trim', 'Belt', 'Boots'], 3: ['Weapon', 'Eyes'] },
      priest: { 1: ['Clothing', 'Skin'], 2: ['Trim', 'Belt', 'Boots'], 3: ['Weapon', 'Holy symbol'] },
      shaman: { 1: ['Pelt', 'Skin'], 2: ['Clothing', 'Boots', 'Face paint'], 3: ['Weapon'] },
      berserker: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Helmet trim', 'Cape', 'Boots'], 3: ['Weapon', 'Horns'] },
      swordsman: { 1: ['Shirt', 'Clothing', 'Skin'], 2: ['Trim', 'Cape', 'Hair', 'Boots'], 3: ['Weapon'] },
      paladin: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Cape', 'Boots', 'Plume'], 3: ['Weapon', 'Shield'] },
    });
  });

  it('preserves every approved female addition exactly', () => {
    expect(Object.fromEntries(CLASSES.map(({ key }) => [key, labelsByTier(key, 'F')]))).toEqual({
      knight: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Belt', 'Cape', 'Hair', 'Boots', 'Lips', 'Plume'], 3: ['Weapon', 'Shield'] },
      thief: { 1: ['Clothing', 'Cape', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Hair', 'Boots', 'Lips', 'Feather'], 3: ['Weapon', 'Accessory'] },
      ranger: { 1: ['Clothing', 'Cloak', 'Headgear', 'Skin'], 2: ['Trim', 'Belt', 'Boots', 'Lips', 'Feather'], 3: ['Weapon', 'Quiver'] },
      wizard: { 1: ['Clothing', 'Cloak', 'Skin'], 2: ['Gold trim', 'Belt', 'Boots'], 3: ['Weapon', 'Eyes'] },
      priest: { 1: ['Clothing', 'Skin'], 2: ['Trim', 'Belt', 'Hair', 'Boots', 'Lips'], 3: ['Weapon', 'Holy symbol'] },
      shaman: { 1: ['Pelt', 'Skin'], 2: ['Clothing', 'Boots', 'Face paint', 'Lips'], 3: ['Weapon'] },
      berserker: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Helmet trim', 'Cape', 'Hair', 'Boots', 'Lips'], 3: ['Weapon', 'Horns'] },
      swordsman: { 1: ['Shirt', 'Clothing', 'Skin'], 2: ['Trim', 'Cape', 'Hair', 'Boots', 'Lips', 'Details'], 3: ['Weapon'] },
      paladin: { 1: ['Clothing', 'Headgear', 'Skin'], 2: ['Cape', 'Hair', 'Boots', 'Lips', 'Plume'], 3: ['Weapon', 'Shield'] },
    });
  });

  it('has one definition per present slot and computes cumulative ownership', () => {
    for (const { key } of CLASSES) for (const gender of ['M', 'F'] as const) {
      const definitions = channelsFor(key, gender);
      expect(new Set(definitions.map((channel) => channel.slot)).size).toBe(definitions.length);
      for (const definition of definitions) {
        expect(channelFor(key, gender, definition.slot)).toEqual(definition);
      }
      expect(entitledChannelsFor(key, gender, 1).every((channel) => channel.requiredTier === 1)).toBe(true);
      expect(lockedChannelsFor(key, gender, 1).every((channel) => channel.requiredTier > 1)).toBe(true);
      expect(entitledChannelsFor(key, gender, 3)).toEqual(definitions);
    }
  });

  it('contains exactly the nine known classes', () => {
    expect(Object.keys(COSMETIC_CHANNELS)).toEqual(CLASSES.map(({ key }) => key));
  });
});
