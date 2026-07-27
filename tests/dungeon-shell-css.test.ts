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

  it('keeps the intentional lite frame width beyond both walls', () => {
    expect(css).toMatch(/body\.frame-lite main\{max-width:1180px;padding-inline:max\(var\(--shell-inline\),calc\(var\(--wall\) \+ var\(--shell-gap\)\)\)\}/);

    const wall = 66;
    const gap = 12;
    const standardWidth = 1120;
    const liteWidth = 1180;
    const standardInline = (viewport: number) => Math.max(34, Math.min(wall + gap, wall + gap + 560 - viewport / 2));
    const standardEdge = (viewport: number) => (viewport - standardWidth) / 2 + standardInline(viewport);
    const liteInline = (viewport: number) => Math.max(standardInline(viewport), wall + gap);
    const liteEdge = (viewport: number) => Math.max(0, (viewport - liteWidth) / 2) + liteInline(viewport);

    expect(standardInline(1180)).toBe(48);
    expect(standardEdge(1180)).toBe(78);
    expect(liteInline(1180)).toBe(78);
    expect(liteEdge(1180)).toBe(78);
  });
});
