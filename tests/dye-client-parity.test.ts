import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { toneColorize } from '../src/domain/spritetint';

describe('dye browser color parity', () => {
  it('browser Tone math matches server fixture pixels exactly', () => {
    const context: Record<string, unknown> = {};
    vm.runInNewContext(readFileSync('src/web/public/dye-color.js', 'utf8'), context);
    const browser = context.ClaudeRpgDyeColor as { toneColorize: (...args: number[]) => number[] };
    const fixtures: Array<[number, number, number, number, number, number]> = [
      [243, 243, 243, 0, 0.6, -1],
      [145, 145, 145, 210, 0.13, -0.12],
      [207, 50, 50, 46, 0.75, 0],
      [90, 30, 10, 280, 0.6, 0.65],
      [255, 255, 255, 120, 0.6, 1],
    ];
    for (const args of fixtures) {
      expect(Array.from(browser.toneColorize(...args))).toEqual(toneColorize(...args));
    }
  });
});
