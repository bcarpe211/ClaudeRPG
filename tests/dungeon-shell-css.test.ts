import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/dungeon.css', 'utf8');

describe('responsive dungeon shell safe area', () => {
  it('drives header, content, and footer from one wall-aware inline inset', () => {
    expect(css).toMatch(/:root\{[^}]*--shell-gap:12px[^}]*--shell-inline:34px/);
    expect(css).toMatch(/\.bar\{[^}]*padding:22px var\(--shell-inline\)/);
    expect(css).toMatch(/main\{[^}]*padding:8px var\(--shell-inline\) 40px/);
    expect(css).toMatch(/\.foot\{[^}]*padding:20px var\(--shell-inline\) 0/);
  });

  it('hides gutter loot before it can meet the shell and narrows walls on small screens', () => {
    expect(css).toMatch(/@media \(max-width:1252px\)\{[\s\S]*?\.loot-rail\{display:none\}/);
    expect(css).toMatch(/@media \(max-width:1252px\)\{[\s\S]*?--shell-inline:clamp\(/);
    expect(css).toMatch(/@media \(max-width:760px\)\{[\s\S]*?:root\{--wall:48px/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?:root\{--wall:36px;--shell-gap:8px/);
    expect(css).toMatch(/\.sconce\{[^}]*width:min\(48px,var\(--wall\)\)[^}]*height:min\(48px,var\(--wall\)\)/);
  });
});
