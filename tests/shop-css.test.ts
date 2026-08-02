import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/web/public/dungeon.css', 'utf8');
const marketplace = css.slice(css.indexOf('/* Gilded Mimic marketplace */'));

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return marketplace.match(new RegExp(`${escaped}\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Gilded Mimic marketplace CSS', () => {
  it('keeps the Adventurer Ledger sticky and wraps its four stats into two rows at 760px', () => {
    const ledger = declarations('.adventurer-ledger');
    expect(ledger).toContain('position:sticky');
    expect(ledger).toContain('bottom:');
    expect(marketplace).toMatch(
      /@media \(max-width:760px\)\{[\s\S]*?\.ledger-stats\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
    );
  });

  it('floats the player without a circular backdrop and preserves pixel-art depth', () => {
    expect(marketplace).not.toContain('.bazaar-player::before');
    expect(declarations('.bazaar-player canvas')).toMatch(
      /drop-shadow\([^)]*\)[^;]*drop-shadow\([^)]*\)[^;]*drop-shadow\(/,
    );
  });

  it('uses a compact reusable product card without a fixed height', () => {
    const product = declarations('.bazaar-product');
    expect(product).toContain('padding:20px');
    expect(product).toContain('border-radius:');
    expect(product).not.toMatch(/(?:^|;)height:/);
    expect(product).not.toContain('min-height:');
  });

  it('clips merchant decorations so they cannot grow the page horizontally', () => {
    const head = declarations('.gilded-mimic-head');
    const stock = declarations('.gilded-mimic-stock');
    expect(head).toContain('overflow:hidden');
    expect(stock).toContain('inset:0');
    expect(stock).toContain('pointer-events:none');
  });

  it('contains the purchase burst in a fixed non-interactive layer', () => {
    const burst = declarations('.purchase-burst');
    expect(burst).toContain('position:fixed');
    expect(burst).toContain('inset:0');
    expect(burst).toContain('overflow:hidden');
    expect(burst).toContain('pointer-events:none');
  });

  it('uses bounded transform-and-opacity motion without collapsing sprites to zero', () => {
    const sprite = declarations('.purchase-burst-sprite');
    expect(sprite).toContain('scale(.65)');
    expect(sprite).toContain('animation:');
    expect(marketplace).toContain('scale(1.35)');
    expect(marketplace).not.toContain('scale(0)');
    expect(marketplace).toMatch(
      /@keyframes purchase-card-jolt\{[\s\S]*?transform:[^;}]+[\s\S]*?\}/,
    );
    expect(marketplace).toMatch(
      /@keyframes purchase-burst-flight\{[\s\S]*?transform:[^;}]+[\s\S]*?opacity:/,
    );
  });

  it('removes moving purchase effects under reduced motion and retains only a button glow', () => {
    expect(marketplace).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.purchase-forging-card[\s\S]*?animation:none/,
    );
    expect(marketplace).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.purchase-burst[\s\S]*?display:none/,
    );
    expect(marketplace).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.purchase-forging-button[\s\S]*?purchase-button-glow/,
    );
  });

  it('layers the closed stall inside the Gilded Mimic marketplace shell', () => {
    expect(marketplace).toMatch(/\.bazaar-open \.bazaar-closed\{[^}]*position:relative[^}]*z-index:1/);
  });

  it('keeps potion stock in a bounded two-column grid that collapses before the moss walls', () => {
    const grid = declarations('.bazaar-product-grid');
    expect(grid).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(grid).toContain('max-width:');
    expect(grid).toContain('min-width:0');
    expect(marketplace).toMatch(
      /@media \(max-width:760px\)\{[\s\S]*?\.bazaar-product-grid\{[^}]*grid-template-columns:1fr/,
    );
  });

  it('keeps potion art pixelated and scopes the Gold recolor to its own card', () => {
    expect(declarations('.bazaar-potion-icon')).toContain('image-rendering:pixelated');
    expect(declarations('.potion-gold .bazaar-potion-icon')).toContain('filter:');
    expect(declarations('.potion-damage .bazaar-potion-icon')).not.toContain('filter:');
  });

  it('stacks potion metadata before its tier badge can clip at 320px', () => {
    expect(marketplace).toMatch(
      /@media \(max-width:480px\)\{[\s\S]*?\.bazaar-potion-head \.bazaar-product-meta\{[^}]*flex-direction:column[^}]*align-items:flex-start[^}]*gap:5px/,
    );
  });

  it('gives sold-out cards a visible disabled state without hiding their stock', () => {
    expect(declarations('.bazaar-product.is-sold-out')).toContain('opacity:');
    expect(declarations('.bazaar-product.is-sold-out button')).toContain('cursor:not-allowed');
  });

  it('keeps the one-time potion result compact and inside the marketplace gutter', () => {
    const shell = declarations('.bazaar-open');
    const result = declarations('.bazaar-potion-result');

    expect(shell).toContain('--bazaar-gutter:clamp(22px,4vw,44px)');
    expect(result).toContain('box-sizing:border-box');
    expect(result).toContain('width:max-content');
    expect(result).toContain('max-width:calc(100% - 2 * var(--bazaar-gutter))');
    expect(result).toContain('padding:6px 10px!important');
    expect(marketplace).toMatch(
      /@media \(max-width:760px\)\{[\s\S]*?\.bazaar-open\{[^}]*--bazaar-gutter:18px/,
    );
    expect(marketplace).toMatch(
      /@media \(max-width:480px\)\{[\s\S]*?\.bazaar-open\{[^}]*--bazaar-gutter:13px/,
    );
  });
});
