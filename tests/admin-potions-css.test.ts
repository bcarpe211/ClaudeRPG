import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.resolve('src/web/views/admin-potions.ejs'),
  'utf8',
);

describe('Potion Lab responsive layout', () => {
  it('allows report grid items and scrollable tables to shrink inside the moss wall', () => {
    expect(view).toMatch(/\.lab-shell\{[^}]*min-width:0/);
    expect(view).toMatch(/\.lab-section\{[^}]*min-width:0/);
    expect(view).toMatch(/\.lab-filter\{[^}]*min-width:0/);
    expect(view).toMatch(/\.lab-table-wrap\{[^}]*max-width:100%/);
  });

  it('lets the two-column mobile metric grid shrink without widening the page', () => {
    expect(view).toMatch(/\.lab-metric\{[^}]*min-width:0/);
    expect(view).toMatch(/\.lab-metric strong\{[^}]*overflow-wrap:anywhere/);
    expect(view).toMatch(
      /@media\(max-width:760px\)\{[\s\S]*?\.lab-metrics\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
    );
  });
});
