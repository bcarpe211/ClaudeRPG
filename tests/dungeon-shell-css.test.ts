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
    expect(css).toMatch(/body\.frame-lite main\{max-width:1180px\}/);
    expect(css).toMatch(/@media \(max-width:1268px\)\{[\s\S]*?body\.frame-lite main\{padding-inline:clamp\(/);
    expect(css).toContain('calc(34px + (1268px - 100vw)/2)');
    expect(css).toContain('calc(var(--wall) + var(--shell-gap))');

    const wall = 66;
    const gap = 12;
    const liteInline = (viewport: number, wall: number, gap: number) => Math.max(34, Math.min(wall + gap, 34 + (1268 - viewport) / 2));
    const standardWidth = 1120;
    const liteWidth = 1180;
    const standardInline = (viewport: number) => Math.max(34, Math.min(wall + gap, wall + gap + 560 - viewport / 2));
    const standardEdge = (viewport: number) => (viewport - standardWidth) / 2 + standardInline(viewport);
    const liteEdge = (viewport: number, wall: number, gap: number) => Math.max(0, (viewport - liteWidth) / 2) + liteInline(viewport, wall, gap);

    expect(standardInline(1180)).toBe(48);
    expect(standardEdge(1180)).toBe(78);
    expect(liteEdge(1600, 66, 12)).toBe(244);
    expect(liteInline(1268, 66, 12)).toBe(34);
    expect(liteEdge(1268, 66, 12)).toBe(78);
    expect(liteInline(1180, 66, 12)).toBe(78);
    expect(liteEdge(1180, 66, 12)).toBe(78);
    expect(liteInline(760, 48, 12)).toBe(60);
    expect(liteInline(480, 36, 8)).toBe(44);
  });
});

describe('Runtime Raiders dungeon-shell palette', () => {
  it('keeps the purple dungeon surfaces and the gilded brand color', () => {
    expect(css).toMatch(/--panel:#160f20;--panel2:#1c1329;--card:#221631;--line:#2e2140/);
    expect(css).toContain('--gold:#e8c96a');
    expect(css).toContain('--guild-wine:#54282b');
    expect(css).toContain('background-color:#0c0912');
  });

  it('uses a restrained wine edge instead of a slate shell repaint', () => {
    expect(css).toMatch(/\.brand-wordmark\{[^}]*border-bottom:2px solid var\(--guild-wine\)/);
    expect(css).not.toMatch(/background-color:\s*#(?:0f172a|111827|1e293b|334155)/i);
  });

  it('gives the wordmark readable primary and companion weights on narrow screens', () => {
    expect(css).toMatch(/\.brand-primary\{[^}]*color:var\(--gold\)[^}]*font-weight:900/);
    expect(css).toMatch(/\.brand-companion\{[^}]*font-weight:700/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?\.brand\{[^}]*font-size:18px/);
  });
});
