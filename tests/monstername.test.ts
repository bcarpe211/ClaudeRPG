import { describe, it, expect } from 'vitest';
import { monsterTitle, pluralizeCreature } from '../src/domain/monstername';
import { monsterName } from '../src/domain/bestiary';

describe('monsterTitle', () => {
  it('is deterministic for the same inputs', () => {
    expect(monsterTitle(42, 291, 'undead')).toBe(monsterTitle(42, 291, 'undead'));
  });

  it('is "<Adjective> <Creature name>"', () => {
    const t = monsterTitle(7, 291, 'undead'); // Skeleton
    expect(t.endsWith(monsterName(291))).toBe(true);
    expect(t.split(' ')[0][0]).toBe(t.split(' ')[0][0].toUpperCase()); // capitalized adjective
    expect(t.length).toBeGreaterThan(monsterName(291).length + 1);
  });

  it('varies across encounter ids', () => {
    const titles = new Set(Array.from({ length: 40 }, (_, i) => monsterTitle(i + 1, 291, 'undead')));
    expect(titles.size).toBeGreaterThan(1);
  });

  it('pluralizes the creature noun when plural is set (a pack of several)', () => {
    // 296 = Mummy -> "... Mummies", not "... Mummy"
    const t = monsterTitle(7, 296, 'undead', true);
    expect(t.endsWith('Mummies')).toBe(true);
    expect(t.endsWith('Mummy')).toBe(false);
    // same adjective as the singular, only the noun changes
    expect(t.split(' ')[0]).toBe(monsterTitle(7, 296, 'undead').split(' ')[0]);
  });
});

describe('pluralizeCreature', () => {
  it('applies regular English rules, pluralizing the head noun', () => {
    expect(pluralizeCreature('Mummy')).toBe('Mummies');
    expect(pluralizeCreature('Grey Wolf')).toBe('Grey Wolves');
    expect(pluralizeCreature('Green Witch')).toBe('Green Witches');
    expect(pluralizeCreature('Skeleton')).toBe('Skeletons');
    expect(pluralizeCreature('Goblin Archer')).toBe('Goblin Archers');
    expect(pluralizeCreature('Cobra')).toBe('Cobras');
    expect(pluralizeCreature('Green Slime')).toBe('Green Slimes');
  });
});
