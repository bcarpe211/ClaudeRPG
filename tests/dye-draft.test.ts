import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

interface DyeState {
  recipe: string;
  hue: number;
  sat: number;
  tone: number;
}

interface DyeDraftApi {
  cloneStates(states: Map<number, DyeState>): Map<number, DyeState>;
  equalState(left: DyeState | undefined, right: DyeState | undefined): boolean;
  dirtyOperations(saved: Map<number, DyeState>, draft: Map<number, DyeState>): unknown[];
}

let api: DyeDraftApi;

beforeEach(() => {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync('src/web/public/dye-draft.js', 'utf8'), context);
  api = context.ClaudeRpgDyeDraft as DyeDraftApi;
});

describe('dye browser draft helpers', () => {
  it('clones states and serializes every dirty slot in numeric order', () => {
    const saved = new Map([[1, { recipe: 'wheel', hue: 20, sat: 0.6, tone: 0 }]]);
    const draft = api.cloneStates(saved);
    draft.set(1, { recipe: 'wheel', hue: 80, sat: 0.6, tone: 0.25 });
    draft.set(2, { recipe: 'gold', hue: 46, sat: 0.75, tone: 0.1 });
    expect(api.dirtyOperations(saved, draft)).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 80, tone: 0.25 },
      { action: 'set', slot: 2, recipe: 'gold', tone: 0.1 },
    ]);
    draft.delete(1);
    expect(api.dirtyOperations(saved, draft)[0]).toEqual({ action: 'clear', slot: 1 });
    expect(saved.get(1)?.hue).toBe(20);
  });

  it('compares normalized recipe values and treats missing states explicitly', () => {
    expect(api.equalState(
      { recipe: 'wheel', hue: -20, sat: 0.6, tone: -0 },
      { recipe: 'wheel', hue: 340, sat: 0.6, tone: 0 },
    )).toBe(true);
    expect(api.equalState(undefined, undefined)).toBe(true);
    expect(api.equalState(
      undefined,
      { recipe: 'wheel', hue: 0, sat: 0.6, tone: 0 },
    )).toBe(false);
  });
});
