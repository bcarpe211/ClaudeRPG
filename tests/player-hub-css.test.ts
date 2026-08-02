import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/player-hub.css', 'utf8');

describe('player hub layout CSS', () => {
  it('keeps the hub inside the moss-wall safe area', () => {
    expect(css).toContain('calc(var(--wall) + var(--shell-gap))');
    expect(css).toMatch(/\.player-hub-shell[\s\S]*max-width/);
  });

  it('uses compact desktop grids and stacked narrow layouts', () => {
    const constrainedPanel = css.slice(
      css.indexOf('@container (max-width:739px)'),
      css.indexOf('@container (max-width:520px)'),
    );

    expect(css).toMatch(/\.hub-live-grid[\s\S]*grid-template-columns/);
    expect(css).toMatch(/\.hub-inventory-layout[\s\S]*grid-template-columns/);
    expect(css).toMatch(/\.hub-panel\{[^}]*container-type:\s*inline-size/);
    expect(constrainedPanel).toMatch(/\.hub-live-grid\{[^}]*grid-template-columns:\s*1fr/);
    expect(constrainedPanel).toMatch(/\.hub-inventory-layout\{[^}]*grid-template-columns:\s*1fr/);
  });

  it('keeps the wide potion ledger aligned with the inventory room', () => {
    const constrainedPanel = css.slice(
      css.indexOf('@container (max-width:739px)'),
      css.indexOf('@container (max-width:520px)'),
    );

    expect(css).toMatch(
      /\.hub-item-detail\{[^}]*box-sizing:border-box[^}]*height:auto[^}]*min-height:288px[^}]*padding:12px/,
    );
    expect(css).toMatch(
      /#hub-item-detail-content\{[^}]*display:flex[^}]*height:auto[^}]*min-height:262px[^}]*flex-direction:column/,
    );
    expect(css).toMatch(/\.hub-item-detail-head\{[^}]*display:grid[^}]*grid-template-columns:70px minmax\(0,1fr\)[^}]*gap:10px/);
    expect(css).toMatch(/\.hub-item-detail-head \.hub-item-icon\{[^}]*justify-self:start[^}]*margin:0/);
    expect(css).toMatch(/\.hub-item-detail h3\{[^}]*font-size:16px[^}]*line-height:1\.2/);
    expect(css).toMatch(/\.hub-item-detail dl\{[^}]*grid-template-columns:70px minmax\(0,1fr\)[^}]*gap:5px 10px[^}]*margin:10px 0 0[^}]*font-size:11px/);
    expect(css).toMatch(/\.hub-item-active-progress\{[^}]*margin-top:8px[^}]*padding:7px/);
    expect(css).toMatch(
      /\.hub-item-detail \.btn\{[^}]*box-sizing:border-box[^}]*flex:0 0 auto[^}]*width:100%[^}]*max-width:100%[^}]*margin-top:auto/,
    );
    expect(constrainedPanel).toMatch(/\.hub-item-detail\{[^}]*height:auto[^}]*min-height:190px/);
    expect(constrainedPanel).toMatch(/#hub-item-detail-content\{[^}]*height:auto[^}]*min-height:0/);
    expect(constrainedPanel).toMatch(/\.hub-item-detail \.btn\{[^}]*margin-top:14px/);
  });

  it('lays out the tight dungeon beside leaders with Today across the bottom', () => {
    expect(css).toMatch(/\.hub-live-grid\{[^}]*grid-template-columns:\s*minmax\(0,480px\) minmax\(240px,1fr\)/);
    expect(css).toMatch(/\.hub-live-grid\{[^}]*grid-template-areas:\s*"dungeon leaders" "today today"/);
    expect(css).toMatch(/\.hub-live-grid\{[^}]*gap:\s*12px 20px/);
    expect(css).toMatch(/\.hub-today-panel h3\{[^}]*margin:\s*0 0 6px/);
    expect(css).toMatch(/\.hub-dungeon\{[^}]*aspect-ratio:\s*6\/5/);
    expect(css).toMatch(/\.hub-dungeon\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.hub-dungeon::before\{[^}]*top:\s*10%/);
    expect(css).toMatch(/\.hub-dungeon::before\{[^}]*8px 10px 20px -11px/);
    expect(css).not.toMatch(/\.hub-dungeon::before\{[^}]*0 0 0 2px/);
    expect(css).toMatch(/\.hub-fight-leaders\{[^}]*grid-area:\s*leaders/);
    expect(css).toMatch(
      /\.hub-fight-leaders\{[^}]*display:flex[^}]*flex-direction:column[^}]*max-height:400px[^}]*overflow:hidden/,
    );
    expect(css).toMatch(
      /#hub-leaders\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow-y:auto[^}]*overscroll-behavior:contain[^}]*scrollbar-gutter:stable/,
    );
    expect(css).toMatch(
      /#hub-leaders:focus-visible\{[^}]*outline:2px solid var\(--gold\)[^}]*outline-offset:3px/,
    );
    expect(css).toMatch(/\.hub-today-panel\{[^}]*grid-area:\s*today/);
    expect(css).toMatch(/\.hub-today\{[^}]*grid-template-columns:\s*repeat\(6,minmax\(0,1fr\)\)/);
    expect(css).toMatch(/@container \(max-width:\s*739px\)[\s\S]*grid-template-areas:\s*"dungeon" "leaders" "today"/);
    expect(css).toMatch(/@container \(max-width:\s*739px\)[\s\S]*\.hub-dungeon\{[^}]*justify-self:\s*center[^}]*width:\s*min\(480px,100%\)/);
    expect(css).toMatch(/@container \(max-width:\s*739px\)[\s\S]*\.hub-today\{[^}]*repeat\(3,minmax\(0,1fr\)\)/);
    expect(css).toMatch(/@media \(max-width:\s*480px\)[\s\S]*\.hub-today\{[^}]*repeat\(2,minmax\(0,1fr\)\)/);
    expect(css).not.toContain('.hub-live-side');
  });

  it('builds the approved snapped inventory room from the world atlas', () => {
    expect(css).toMatch(/\.hub-inventory-layout\{[^}]*grid-template-columns:\s*minmax\(0,2fr\) minmax\(240px,1fr\)/);
    expect(css).toMatch(/\.hub-inventory-room\{[^}]*--room-columns:\s*9[^}]*--room-rows:\s*6/);
    expect(css).toMatch(/\.hub-room-tiles\{[^}]*grid-template-columns:\s*repeat\(var\(--room-columns\),48px\)/);
    expect(css).toMatch(/\.hub-room-tile\{[^}]*background-size:\s*2732px 2014px/);
    expect(css).toContain('background-position:-192px -576px');
    expect(css).toContain('background-position:-1440px -1776px');
    expect(css).toContain('-816px -624px');
    expect(css).toContain('-960px -624px');
    expect(css).toMatch(/\.hub-inventory-grid\{[^}]*grid-template-columns:\s*repeat\(7,48px\)/);
    expect(css).toMatch(/@container \(max-width:\s*520px\)[\s\S]*--room-columns:\s*6[\s\S]*--room-rows:\s*9/);
    expect(css).toMatch(/@container \(max-width:\s*520px\)[\s\S]*\.hub-inventory-grid\{[^}]*repeat\(4,48px\)/);
    expect(css).not.toContain('moss_wall.png');
    expect(css).not.toContain('.hub-room-door');
    expect(css).not.toContain('.hub-room-crack');
    expect(css).toMatch(/\.hub-item-qty\{[^}]*top:/);
    expect(css).toMatch(/\.hub-item-qty\{[^}]*text-shadow:/);
  });

  it('fits the narrow inventory room inside the 320px moss-wall safe area', () => {
    const narrowViewport = css.slice(css.indexOf('@media (max-width:360px)'));
    const safePanelWidth = 320 - 2 * (36 + 8) - 2 * 13;
    const roomWidth = 6 * 34;

    expect(roomWidth).toBeLessThanOrEqual(safePanelWidth);
    expect(narrowViewport).toMatch(
      /\.hub-inventory-room\{[^}]*width:204px[^}]*height:306px/,
    );
    expect(narrowViewport).toMatch(
      /\.hub-room-tiles\{[^}]*width:288px[^}]*height:432px[^}]*transform:scale\(\.7083333333\)[^}]*transform-origin:top left/,
    );
    expect(narrowViewport).toMatch(
      /\.hub-inventory-grid\{[^}]*left:34px[^}]*top:34px[^}]*transform:scale\(\.7083333333\)[^}]*transform-origin:top left/,
    );
  });

  it('resets every narrow interior tile to plain Duskstone with stronger specificity', () => {
    const narrowRoom = css.slice(
      css.indexOf('@container (max-width:520px)'),
      css.indexOf('@media (max-width:760px)'),
    );
    const interiorIndices = [
      ...Array.from({ length: 4 }, (_, offset) => 8 + offset),
      ...Array.from({ length: 4 }, (_, offset) => 14 + offset),
      ...Array.from({ length: 4 }, (_, offset) => 20 + offset),
      ...Array.from({ length: 4 }, (_, offset) => 26 + offset),
      ...Array.from({ length: 4 }, (_, offset) => 32 + offset),
      ...Array.from({ length: 4 }, (_, offset) => 38 + offset),
      ...Array.from({ length: 4 }, (_, offset) => 44 + offset),
    ];
    const resetStart = narrowRoom.indexOf('.hub-inventory-room .hub-room-tile:nth-child(8)');
    const resetEnd = narrowRoom.indexOf('}', resetStart);
    const edgeOverrideStart = narrowRoom.indexOf('.hub-room-tile:nth-child(-n+6)');
    const reset = narrowRoom.slice(resetStart, resetEnd);

    expect(resetStart).toBeGreaterThan(-1);
    expect(resetStart).toBeLessThan(edgeOverrideStart);
    expect(reset).toMatch(/background-position:-192px -576px/);
    for (const index of interiorIndices) {
      expect(reset).toContain(`.hub-inventory-room .hub-room-tile:nth-child(${index})`);
    }
  });

  it('resets Today padding inherited from the global section rule', () => {
    expect(css).toMatch(/\.hub-today-panel\{[^}]*grid-area:today;min-width:0;padding:0/);
  });

  it('limits narrow TV floor shadows to the approved top-interior cells', () => {
    const narrowRoom = css.slice(
      css.indexOf('@container (max-width:520px)'),
      css.indexOf('@media (max-width:760px)'),
    );
    const narrowShadowCells = [...narrowRoom.matchAll(/\.hub-room-tile:nth-child\((\d+)\)::after/g)]
      .map((match) => Number(match[1]));

    expect(narrowRoom).toMatch(/\.hub-room-tile:nth-child\(11\)::after,[\s\S]*\.hub-room-tile:nth-child\(17\)::after\{content:none\}/);
    expect(narrowRoom).toMatch(/\.hub-room-tile:nth-child\(8\)::after,[\s\S]*\.hub-room-tile:nth-child\(11\)::after\{content:""\}/);
    expect(narrowShadowCells).toEqual([11, 12, 13, 14, 15, 16, 17, 8, 9, 10, 11]);
  });

  it('keeps the gold tab rail sticky on narrow screens and reanchors effects', () => {
    expect(css).toMatch(/\.hub-tabs[\s\S]*border/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-tabs[\s\S]*position:\s*sticky/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-effects[\s\S]*(left|inset)/);
    expect(css).toMatch(/\.hub-avatar-wrap\{[^}]*--hub-avatar-size:\s*94px/);
    expect(css).toMatch(/\.hub-effects\{[^}]*left:\s*var\(--hub-avatar-size\)/);
    expect(css).toMatch(/@media \(max-width:\s*480px\)[\s\S]*\.hub-avatar-wrap\{[^}]*--hub-avatar-size:\s*76px/);
  });

  it('bounds the scalable effect surface and styles potion confirmation and feedback', () => {
    expect(css).toMatch(/\.hub-effects-list[\s\S]*max-height[\s\S]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.hub-effect-progress[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.potion-confirm[\s\S]*backdrop/);
    expect(css).toMatch(/\.hub-potion-feedback/);
  });

  it('uses a short reduced-motion-safe profile bottle burst without a persistent badge', () => {
    expect(css).toMatch(/\.hub-bottle-burst\.is-bursting[\s\S]*animation/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)[\s\S]*\.hub-bottle-burst/);
    expect(css).not.toContain('.hub-persistent-potion-icon');
  });
});
