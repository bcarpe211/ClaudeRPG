import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/player-hub.css', 'utf8');

describe('player hub layout CSS', () => {
  it('keeps the hub inside the moss-wall safe area', () => {
    expect(css).toContain('calc(var(--wall) + var(--shell-gap))');
    expect(css).toMatch(/\.player-hub-shell[\s\S]*max-width/);
  });

  it('uses compact desktop grids and stacked narrow layouts', () => {
    expect(css).toMatch(/\.hub-live-grid[\s\S]*grid-template-columns/);
    expect(css).toMatch(/\.hub-inventory-layout[\s\S]*grid-template-columns/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-live-grid[\s\S]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-inventory-layout[\s\S]*grid-template-columns:\s*1fr/);
  });

  it('builds a two-thirds dungeon-room inventory from existing pixel assets', () => {
    expect(css).toMatch(/\.hub-inventory-layout\{[^}]*grid-template-columns:\s*minmax\(0,2fr\) minmax\(240px,1fr\)/);
    expect(css).toMatch(/\.hub-inventory-room\{[^}]*border-image:[^}]*moss_wall\.png/);
    expect(css).toContain('/sprites/world_24x24/oryx_16bit_fantasy_world_349.png');
    expect(css).toContain('/sheet/world.png');
    expect(css).toMatch(/\.hub-room-door\{[^}]*background-position:\s*-1392px -144px/);
    expect(css).toMatch(/\.hub-item-qty\{[^}]*top:/);
    expect(css).toMatch(/\.hub-item-qty\{[^}]*text-shadow:/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.hub-inventory-layout[^}]*grid-template-columns:\s*1fr/);
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
