import { describe, it, expect } from 'vitest';
import { generateDungeon } from '../src/domain/dungeon';
import { themeTiles } from '../src/domain/tilemanifest';

function inMonsterZone(d: ReturnType<typeof generateDungeon>, x: number, y: number) {
  return x >= d.monster.x && x <= d.monster.x + 1 && y >= d.monster.y && y <= d.monster.y + 1;
}

describe('dungeon placement', () => {
  it('reserves a 2x2 monster zone of floor tiles within the interior', () => {
    const d = generateDungeon('stone_crypt', 11);
    expect(d.monster.footprint).toBe(2);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = d.monster.x + dx, y = d.monster.y + dy;
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(d.width - 1);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(d.height - 1);
      expect(d.cells[y][x].type).toBe('floor');
    }
  });

  it('produces spread hero slots on interior floor, none in the monster zone, all unique', () => {
    const d = generateDungeon('cave', 22, { heroSlots: 24 });
    expect(d.heroSlots.length).toBeGreaterThan(0);
    expect(d.heroSlots.length).toBeLessThanOrEqual(24);
    const seen = new Set<string>();
    for (const p of d.heroSlots) {
      expect(d.cells[p.y][p.x].type).toBe('floor');
      expect(inMonsterZone(d, p.x, p.y)).toBe(false);
      const k = `${p.x},${p.y}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('places decor on floor tiles not overlapping hero slots or the monster zone', () => {
    const d = generateDungeon('wood_fort', 33);
    const t = themeTiles('wood_fort');
    const decorSet = new Set(t.decor);
    const heroKeys = new Set(d.heroSlots.map((p) => `${p.x},${p.y}`));
    expect(d.decor.length).toBeGreaterThanOrEqual(1);
    for (const item of d.decor) {
      expect(d.cells[item.y][item.x].type).toBe('floor');
      expect(inMonsterZone(d, item.x, item.y)).toBe(false);
      expect(heroKeys.has(`${item.x},${item.y}`)).toBe(false);
      expect(decorSet.has(item.sprite)).toBe(true);
    }
  });

  it('stays fully deterministic including placement', () => {
    expect(generateDungeon('cave', 555)).toEqual(generateDungeon('cave', 555));
  });
});
