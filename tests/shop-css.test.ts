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
});
