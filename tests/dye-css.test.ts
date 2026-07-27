import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('gives failed Wardrobe channels a visible non-color error indicator', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  expect(css).toContain('.dye-chan.save-failed');
  expect(css).toContain('.dye-chan[aria-invalid="true"]');
  expect(css).toContain('content:"!"');
});

it('keeps Reload hidden until stale recovery removes the hidden attribute', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const hiddenReload = css.match(/\.dye-reload\[hidden\]\{([^}]*)\}/)?.[1] ?? '';

  expect(hiddenReload).toContain('display:none!important');
  expect(css).not.toMatch(/\.dye-reload\{[^}]*display:none/);
});

it('uses the approved black stage shadow and layered character shadows', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const stageShadow = css.match(/\.dye-stage::after\{([^}]*)\}/)?.[1] ?? '';

  expect(stageShadow).toContain('bottom:54px');
  expect(stageShadow).toContain('width:116px');
  expect(stageShadow).toContain('height:18px');
  expect(stageShadow).toContain('background:radial-gradient(ellipse,#000c 0 36%,#0007 48%,transparent 72%)');
  expect(stageShadow).toContain('filter:blur(2px)');
  expect(stageShadow).not.toMatch(/#604c29|#6f592d|#332619/);
  expect(css).toMatch(/\.dye-preview[^}]*drop-shadow\([^)]*\)[^}]*drop-shadow\(/);
  expect(css).toMatch(/\.character-avatar img[^}]*drop-shadow\([^)]*\)[^}]*drop-shadow\(/);
});

it('styles Tone for both browser engines with endpoint-to-endpoint tracks', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');

  expect(css).toMatch(/\.dye-tone-track input\{[^}]*appearance:none[^}]*margin:0[^}]*\}/);
  expect(css).toContain('.dye-tone-track input::-webkit-slider-runnable-track');
  expect(css).toContain('.dye-tone-track input::-webkit-slider-thumb');
  expect(css).toContain('.dye-tone-track input::-moz-range-track');
  expect(css).toContain('.dye-tone-track input::-moz-range-thumb');
});

it('lays all four material finishes out as equal compact rows', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');

  expect(css).toMatch(/\.dye-finishes\{[^}]*grid-template-columns:1fr[^}]*\}/);
  expect(css).toMatch(/\.dye-fin\{[^}]*height:44px[^}]*\}/);
  expect(css).toContain('.dye-fin-swatch{display:grid;place-items:center;width:22px;height:22px');
  expect(css).not.toContain('.dye-default{grid-column:1/-1');
});

it('aligns a compact stage header and removes the center guide', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const header = css.match(/\.dye-stage-head\{([^}]*)\}/)?.[1] ?? '';
  const status = css.match(/\.dye-save-status\{([^}]*)\}/)?.[1] ?? '';
  const stage = css.match(/\.dye-stage\{([^}]*)\}/)?.[1] ?? '';

  expect(header).toContain('position:absolute');
  expect(header).toContain('display:flex');
  expect(header).toContain('align-items:center');
  expect(header).toContain('left:12px');
  expect(header).toContain('right:10px');
  expect(status).toContain('position:static');
  expect(status).toContain('padding:4px 7px');
  expect(status).toContain('font-size:9px');
  expect(css).toMatch(/\.dye-save-status::before\{[^}]*width:5px[^}]*height:5px/);
  expect(stage).toContain('background:linear-gradient(180deg,#21142f,#120c1b 72%)');
  expect(stage).not.toContain('linear-gradient(90deg');
});

it('keeps short stage statuses on one line while allowing phone-width errors to wrap', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');

  expect(css).toMatch(
    /@media \(max-width:480px\)\{[\s\S]*?\.dye-save-status\{[^}]*white-space:nowrap[^}]*overflow-wrap:normal/,
  );
  expect(css).toMatch(
    /@media \(max-width:480px\)\{[\s\S]*?\.dye-save-status\[data-state="error"\]\{[^}]*white-space:normal[^}]*overflow-wrap:anywhere/,
  );
});

it('integrates the Store and final joined actions without oversized buttons', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const profile = css.match(/\.character-profile-head\{([^}]*)\}/)?.[1] ?? '';
  const strip = css.match(/\.dye-action-strip\{([^}]*)\}/)?.[1] ?? '';
  const action = css.match(/\.dye-action\{([^}]*)\}/)?.[1] ?? '';

  expect(profile).toContain('grid-template-columns:auto minmax(0,1fr) auto');
  expect(css).toContain('.character-store{justify-self:end');
  expect(strip).toContain('display:flex');
  expect(strip).toContain('overflow:hidden');
  expect(action).toContain('flex:1');
  expect(action).toContain('height:40px');
  expect(action).toContain('border-radius:0');
  expect(css).toMatch(/@media \(max-width:620px\)\{[\s\S]*?\.character-store\{[^}]*grid-column:2/);
});

it('keeps the Wardrobe action toast inside the moss walls', () => {
  const css = readFileSync('src/web/public/dungeon.css', 'utf8');
  const toast = css.match(/\.dye-nav-toast\{([^}]*)\}/)?.[1] ?? '';

  expect(css).toContain('.dye-nav-toast[hidden]{display:none!important}');
  expect(toast).toContain('position:fixed');
  expect(toast).toContain('left:calc(var(--wall) + var(--shell-gap))');
  expect(toast).toContain('right:calc(var(--wall) + var(--shell-gap))');
  expect(toast).toContain('max-width:460px');
  expect(toast).toContain('z-index:20');
  expect(css).toMatch(/\.dye-nav-actions\{[^}]*display:flex/);
  expect(css).toMatch(/@media \(max-width:620px\)\{[\s\S]*?\.dye-nav-actions\{[^}]*flex-direction:column/);
});
