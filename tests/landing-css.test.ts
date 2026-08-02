import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/landing.css', 'utf8');

describe('Runtime Raiders landing presentation', () => {
  it('keeps each approved motto sentence on its own line', () => {
    expect(css).toMatch(/\.hero-motto-line\{[^}]*display:block[^}]*white-space:nowrap/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?\.hero-motto\{[^}]*font-size:clamp\(26px,8\.5vw,38px\)/);
  });

  it('leaves shared footer presentation to dungeon.css', () => {
    expect(css).not.toMatch(/\.foot\s*\{/);
  });
});
