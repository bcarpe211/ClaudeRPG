import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/dungeon.css', 'utf8');

describe('responsive dungeon shell safe area', () => {
  it('drifts gutter treasure beneath foreground moss walls without an inner-edge crop', () => {
    expect(css).toMatch(/\.wall\{[^}]*z-index:3/);
    expect(css).toMatch(/\.loot-rail\{[^}]*z-index:1[^}]*overflow:hidden/);
    expect(css).toMatch(/\.loot-rail\.left\{left:0\} \.loot-rail\.right\{right:0\}/);
    expect(css).toMatch(/\.loot\.l\{left:calc\(var\(--wall\) \+ var\(--x\)\)\}/);
    expect(css).toMatch(/\.loot\.r\{right:calc\(var\(--wall\) \+ var\(--x\)\)\}/);
    expect(css).toMatch(
      /\.loot\{[^}]*animation:rail-bob var\(--d\) ease-in-out var\(--delay\) infinite/,
    );
    expect(css).toMatch(/@keyframes rail-bob\{[^}]*translate\(var\(--drift\),-16px\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important[\s\S]*?\.loot\{opacity:\.5\}/);
  });

  it('drives header, content, and footer from one wall-aware inline inset', () => {
    expect(css).toMatch(/:root\{[^}]*--shell-gap:12px[^}]*--shell-inline:34px/);
    expect(css).toMatch(/\.bar\{[^}]*padding:22px var\(--shell-inline\)/);
    expect(css).toMatch(/main\{[^}]*padding:8px var\(--shell-inline\) 40px/);
    expect(css).toMatch(/\.foot\{[^}]*padding:20px var\(--shell-inline\) 0/);
  });

  it('parks gutter loot behind the walls and reverses without display none', () => {
    expect(css).toMatch(
      /\.loot-rail\{[^}]*width:max\(var\(--wall\),calc\(\(100vw - 1120px\)\/2 \+ 18px\)\)[^}]*transform:translateX\(0\)[^}]*opacity:1[^}]*visibility:visible/,
    );
    expect(css).toMatch(
      /@media \(max-width:1431px\)\{[\s\S]*?\.loot-rail\.left\{transform:translateX\(-100%\)\}[\s\S]*?\.loot-rail\.right\{transform:translateX\(100%\)\}/,
    );
    expect(css).toMatch(
      /@media \(max-width:1431px\)\{[\s\S]*?\.loot-rail\{[^}]*opacity:0[^}]*visibility:hidden[^}]*visibility 0s linear 260ms/,
    );
    expect(css).not.toMatch(
      /@media \(max-width:1431px\)\{[\s\S]*?\.loot-rail\{[^}]*display:none/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important[\s\S]*?\.loot-rail\{transition:none!important\}/,
    );
  });

  it('keeps the 1252px shell inset and narrows walls on small screens', () => {
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

  it('stacks the header and lays out direct navigation labels in two columns at 320px', () => {
    expect(css).toMatch(/@media \(max-width:360px\)\{[\s\S]*?\.bar\{[^}]*flex-direction:column[^}]*align-items:flex-start/);
    expect(css).toMatch(/@media \(max-width:360px\)\{[\s\S]*?\.bar nav\{[^}]*display:grid[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*width:100%/);
  });

  it('contains the admin Raider table and stacks its actions on narrow screens', () => {
    expect(css).toMatch(/\.admin-player-table-wrap\{[^}]*max-width:100%[^}]*overflow-x:auto/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?\.admin-player-head\{[^}]*align-items:flex-start[^}]*flex-direction:column/);
    expect(css).toMatch(/@media \(max-width:480px\)\{[\s\S]*?\.admin-player-actions\{[^}]*display:grid[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[^}]*width:100%/);
  });
});
