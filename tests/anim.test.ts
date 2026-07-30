import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isFrameA,
  framePartner,
  frameAt,
  start,
} from '../src/web/public/anim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('TV renderer bootstrap', () => {
  it('shares one stream and renderer while compact mode suppresses only the leaderboard', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'tv', 'tv.js'), 'utf8');

    expect(source).toContain('document.body.dataset.tvMode');
    expect(source).toContain('const SIDEBAR_FRAC = IS_COMPACT ? 0 : 0.30;');
    expect(source).toContain("new EventSource('/tv/stream')");
    expect(source.match(/new EventSource\(/g)).toHaveLength(1);
    expect(source).toContain('if (!IS_COMPACT) drawLeaderboard(t);');
  });

  it('clips the compact room and keeps status and pause treatment compact-only', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'public', 'tv', 'tv.js'),
      'utf8',
    );

    expect(source).toContain('function roundedRectPath(x, y, w, h, radius)');
    expect(source).toContain('function fillRoundedRect(x, y, w, h, radius, color)');
    expect(source).toContain('function withDungeonClip(draw)');
    expect(source).toContain('Math.round(11 * scale)');
    expect(source).toContain('withDungeonClip(() => {');
    expect(source).toContain('if (!IS_COMPACT) {');
    expect(source).toContain('const w = panelW * 0.86;');
    expect(source).toContain('const overlayX = IS_COMPACT ? panelX : 0;');
    expect(source).toContain('const overlayY = IS_COMPACT ? panelY : 0;');
    expect(source).toContain('const defeatX = IS_COMPACT ? panelX : fieldX;');
    expect(source).toContain('const defeatY = IS_COMPACT ? panelY : 0;');
  });

  it('loads the shared potion vocabulary before both TV renderers and layers motes below debuffs', () => {
    const tvSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'tv', 'tv.js'), 'utf8');
    for (const documentName of ['index.html', 'embed.html']) {
      const documentSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'web', 'public', 'tv', documentName),
        'utf8',
      );
      expect(documentSource.indexOf('/static/potion-fx.js')).toBeGreaterThanOrEqual(0);
      expect(documentSource.indexOf('/static/potion-fx.js'))
        .toBeLessThan(documentSource.indexOf('/static/tv/tv.js'));
    }

    const heroes = tvSource.slice(
      tvSource.indexOf('function drawHeroes'),
      tvSource.indexOf('function drawHpBar'),
    );
    expect(tvSource).toContain('ClaudeRpgPotionFx');
    expect(tvSource).toContain('potionFx.frame');
    const drawMotes = tvSource.slice(
      tvSource.indexOf('function drawPotionMotes'),
      tvSource.indexOf('function groundShadow'),
    );
    expect(drawMotes).toContain(
      'const moteScale = Math.max(1, Math.round(sourceScale * 2 / 3));',
    );
    expect(drawMotes).toContain('const size = mote.size * moteScale;');
    expect(drawMotes).toContain('x + moteScale, y + moteScale');
    expect(drawMotes).toContain('ctx.shadowBlur = moteScale;');
    expect(drawMotes).toContain('mote.dx * sourceScale');
    expect(drawMotes).toContain('mote.dy * sourceScale');
    expect(heroes.indexOf('drawSprite(animImg')).toBeLessThan(heroes.indexOf('drawPotionMotes'));
    expect(heroes.indexOf('drawPotionMotes')).toBeLessThan(heroes.indexOf('DEBUFF_BADGE'));
  });
});

describe('isFrameA', () => {
  it('odd sheet rows (frame A) vs even rows (frame B)', () => {
    expect(isFrameA(1)).toBe(true);    // row 1
    expect(isFrameA(18)).toBe(true);   // row 1
    expect(isFrameA(19)).toBe(false);  // row 2 (B)
    expect(isFrameA(37)).toBe(true);   // row 3 (A)
    expect(isFrameA(55)).toBe(false);  // row 4 (B)
    expect(isFrameA(217)).toBe(true);  // row 13 (A)
  });
});

describe('framePartner', () => {
  it('pairs frame A with +18 and frame B with -18', () => {
    expect(framePartner(1)).toBe(19);
    expect(framePartner(19)).toBe(1);
    expect(framePartner(37)).toBe(55);
    expect(framePartner(55)).toBe(37);
    expect(framePartner(217)).toBe(235);
  });
});

describe('frameAt', () => {
  it('toggles 0/1 across each period boundary', () => {
    expect(frameAt(0, 1000)).toBe(0);
    expect(frameAt(999, 1000)).toBe(0);
    expect(frameAt(1000, 1000)).toBe(1);
    expect(frameAt(1999, 1000)).toBe(1);
    expect(frameAt(2000, 1000)).toBe(0);
  });
});

interface FakeSprite {
  classes: Set<string>;
  classList: {
    toggle(name: string, force?: boolean): void;
  };
}

function installSpriteFixture(count = 2): FakeSprite[] {
  const sprites = Array.from({ length: count }, () => {
    const classes = new Set(['sprite-anim']);
    return {
      classes,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force ?? !classes.has(name)) classes.add(name);
          else classes.delete(name);
        },
      },
    };
  });
  vi.stubGlobal('document', {
    querySelectorAll: vi.fn(() => sprites),
  });
  return sprites;
}

describe('start controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps every sprite on the same shared frame', () => {
    const sprites = installSpriteFixture(3);
    const controller = start({ periodMs: 1000 });

    expect(sprites.every(({ classes }) => !classes.has('show-b'))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sprites.every(({ classes }) => classes.has('show-b'))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sprites.every(({ classes }) => !classes.has('show-b'))).toBe(true);
    controller.stop();
  });

  it('does not start or flip sprites when reduced motion is preferred', () => {
    const [sprite] = installSpriteFixture(1);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    const controller = start({ periodMs: 1000 });

    expect(vi.getTimerCount()).toBe(0);
    expect(sprite.classes.has('show-b')).toBe(false);
    expect(controller.isPaused()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(sprite.classes.has('show-b')).toBe(false);
  });

  it('pauses on the current frame and resumes one shared timer', () => {
    const [sprite] = installSpriteFixture(1);
    const controller = start({ periodMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(sprite.classes.has('show-b')).toBe(true);
    controller.pause();
    controller.pause();
    expect(controller.isPaused()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(2000);
    expect(sprite.classes.has('show-b')).toBe(true);

    controller.resume();
    controller.resume();
    expect(controller.isPaused()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(sprite.classes.has('show-b')).toBe(false);
    controller.stop();
  });

  it('stops permanently and prevents later toggles', () => {
    const [sprite] = installSpriteFixture(1);
    const controller = start({ periodMs: 1000 });

    vi.advanceTimersByTime(1000);
    controller.stop();
    controller.resume();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.isPaused()).toBe(true);

    vi.advanceTimersByTime(3000);
    expect(sprite.classes.has('show-b')).toBe(true);
  });

  it('keeps the existing catalog start call backward compatible', () => {
    const sprites = installSpriteFixture();
    const controller = start({ periodMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(sprites.every(({ classes }) => classes.has('show-b'))).toBe(true);
    expect(controller).toMatchObject({
      pause: expect.any(Function),
      resume: expect.any(Function),
      stop: expect.any(Function),
      isPaused: expect.any(Function),
    });
    controller.stop();
  });
});
