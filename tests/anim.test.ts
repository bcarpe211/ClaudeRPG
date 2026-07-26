import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  isFrameA,
  framePartner,
  frameAt,
  start,
} from '../src/web/public/anim.js';

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
