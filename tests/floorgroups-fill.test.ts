import { describe, it, expect } from 'vitest';
import { pickCell, mainTile, FLOOR_GROUPS } from '../src/domain/floorgroups';
import { makeRng } from '../src/domain/dungeon';

const byHandle = (h: string) => FLOOR_GROUPS.find((g) => g.handle === h)!;

describe('pickCell', () => {
  it('blends multiple mains across cells (wildroot_gravel has 3)', () => {
    const g = byHandle('wildroot_gravel');
    expect(g.mains.length).toBe(3);
    const rng = makeRng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) { const t = pickCell(g, rng); seen.add(`${t.col},${t.row}`); }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('a single-main no-accent group always returns that main', () => {
    const g = byHandle('greystone_tile'); // 1 main, 0 accents
    const rng = makeRng(9);
    for (let i = 0; i < 100; i++) expect(pickCell(g, rng)).toEqual(g.mains[0]);
  });

  it('keeps glow accents rare (cinder_rock < 3% over many cells, but present)', () => {
    const g = byHandle('cinder_rock'); // 2 non-glow mains, 2 glow accents
    const rng = makeRng(11);
    let glow = 0; const N = 5000;
    for (let i = 0; i < N; i++) if (pickCell(g, rng).isGlow) glow++;
    expect(glow / N).toBeLessThan(0.03);
    expect(glow).toBeGreaterThan(0);
  });

  it('mainTile returns a base tile', () => {
    const g = byHandle('greystone_flag');
    expect(mainTile(g)).toEqual(g.mains[0]);
  });
});
