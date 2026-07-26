import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('gives failed Wardrobe channels a visible non-color error indicator', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  expect(css).toContain('.dye-chan.save-failed');
  expect(css).toContain('.dye-chan[aria-invalid="true"]');
  expect(css).toContain('content:"!"');
});
