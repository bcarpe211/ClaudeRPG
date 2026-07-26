import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;
type ResponseLike = { ok: boolean };

class FakeClassList {
  private readonly values = new Set<string>();

  constructor(...initial: string[]) {
    for (const value of initial) this.values.add(value);
  }

  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly style = { background: '' };
  readonly classList: FakeClassList;
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  textContent = '';
  disabled = false;

  constructor(classes: string[] = []) {
    this.classList = new FakeClassList(...classes);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

class FakeButton extends FakeElement {
  readonly dot = new FakeElement(['dye-dot', 'is-default']);

  querySelector(selector: string): FakeElement | null {
    return selector === '.dye-dot' ? this.dot : null;
  }
}

class FakeContext {
  imageSmoothingEnabled = false;
  fillStyle = '';
  clearRect(): void {}
  fillRect(): void {}
  drawImage(): void {}
  putImageData(): void {}
  createImageData(width: number, height: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
  getImageData(width: number, height: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
}

class FakeCanvas extends FakeElement {
  width: number;
  height: number;
  private readonly context = new FakeContext();

  constructor(width: number, height: number) {
    super();
    this.width = width;
    this.height = height;
  }

  getContext(): FakeContext {
    return this.context;
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  toDataURL(): string { return 'data:image/png;base64,smoke'; }
}

class FakeImage {
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {}
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface RequestRecord {
  endpoint: string;
  body: URLSearchParams;
}

interface WardrobeHarness {
  clothing: FakeButton;
  cloak: FakeButton;
  weapon: FakeButton;
  wheel: FakeCanvas;
  status: FakeElement;
  defaultButton: FakeButton;
  requests: RequestRecord[];
  responses: Array<Deferred<ResponseLike>>;
  runTimers(): void;
  beforeunload(): void;
  pagehide(): void;
  settle(): Promise<void>;
}

function createWardrobeHarness(config: Record<number, Record<string, number | string>> = {}): WardrobeHarness {
  const clothing = new FakeButton(['dye-chan']);
  clothing.dataset.slot = '1';
  const cloak = new FakeButton(['dye-chan']);
  cloak.dataset.slot = '2';
  const weapon = new FakeButton(['dye-chan']);
  weapon.dataset.slot = '7';
  weapon.disabled = true;

  const wheel = new FakeCanvas(72, 72);
  const preview = new FakeCanvas(168, 168);
  const tone = new FakeElement();
  tone.textContent = '0';
  const toneValue = new FakeElement();
  const status = new FakeElement();
  const activeLabel = new FakeElement();
  const steel = new FakeButton(['dye-fin']);
  steel.dataset.recipe = 'steel';
  const defaultButton = new FakeButton(['dye-fin']);
  defaultButton.dataset.recipe = 'none';
  const elements = new Map<string, FakeElement>([
    ['dye-preview', preview], ['dye-wheel', wheel], ['dye-save-status', status],
    ['dye-active-label', activeLabel], ['dye-tone', tone], ['dye-tone-value', toneValue],
  ]);
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const windowListeners = new Map<string, Listener[]>();
  const requests: RequestRecord[] = [];
  const responses: Array<Deferred<ResponseLike>> = [];
  const document = {
    getElementById(id: string): FakeElement | null { return elements.get(id) ?? null; },
    createElement(tag: string): FakeElement { return tag === 'canvas' ? new FakeCanvas(24, 24) : new FakeElement(); },
    querySelectorAll(selector: string): FakeButton[] {
      if (selector === '.dye-chan:not(:disabled)') return [clothing, cloak];
      if (selector === '.dye-fin') return [steel, defaultButton];
      return [];
    },
  };
  const context: Record<string, unknown> = {
    document,
    Image: FakeImage,
    URLSearchParams,
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(endpoint: string, options: { body: URLSearchParams }) {
      requests.push({ endpoint, body: new URLSearchParams(options.body.toString()) });
      const next = responses.shift();
      return next ? next.promise : Promise.resolve({ ok: true });
    },
    addEventListener(type: string, listener: Listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    __DYE__: {
      token: 'test-token', base: '/sprite.png', slotmap: [],
      channels: [
        { slot: 1, label: 'Clothing', requiredTier: 1 },
        { slot: 2, label: 'Cloak', requiredTier: 1 },
      ],
      config,
      presets: { steel: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 } },
      wheelSat: 0.6,
      revisionSession: 900,
      revisionSeed: 1_000,
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync('src/web/public/dye-color.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('src/web/public/dye.js', 'utf8'), context);

  return {
    clothing, cloak, weapon, wheel, status, defaultButton, requests, responses,
    runTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pagehide() {
      for (const listener of windowListeners.get('pagehide') ?? []) listener({});
    },
    beforeunload() {
      for (const listener of windowListeners.get('beforeunload') ?? []) listener({});
    },
    async settle() {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function pressWheel(harness: WardrobeHarness, key: string): void {
  harness.wheel.dispatch('keydown', { key, preventDefault() {} });
}

describe('dye browser Wardrobe behavior', () => {
  it('initializes against the rendered tier groups, switches enabled channels, and leaves locked channels inert', () => {
    const harness = createWardrobeHarness();

    expect(harness.clothing.classList.contains('active')).toBe(true);
    harness.cloak.dispatch('click');
    expect(harness.cloak.classList.contains('active')).toBe(true);
    harness.weapon.dispatch('click');
    expect(harness.cloak.classList.contains('active')).toBe(true);
  });

  it('keeps independent slot recipes when switching channels before their saves flush', async () => {
    const harness = createWardrobeHarness();

    harness.cloak.dispatch('click');
    pressWheel(harness, 'ArrowRight');
    harness.clothing.dispatch('click');
    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    await harness.settle();

    expect(harness.requests.map((request) => request.body.get('slot'))).toEqual(['2', '1']);
    expect(harness.requests.map((request) => request.body.get('session'))).toEqual(['900', '900']);
    expect(harness.requests.map((request) => request.body.get('revision'))).toEqual(['1000', '1001']);
  });

  it('coalesces rapid wheel changes into the latest normalized recipe', async () => {
    const harness = createWardrobeHarness();

    pressWheel(harness, 'ArrowRight');
    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    await harness.settle();

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ endpoint: '/character/dye/set' });
    expect(harness.requests[0].body.toString()).toBe('token=test-token&slot=1&recipe=wheel&hue=12&tone=0&session=900&revision=1001');
  });

  it('cancels an unsent set when restoring a slot default', async () => {
    const harness = createWardrobeHarness();

    pressWheel(harness, 'ArrowRight');
    harness.defaultButton.dispatch('click');
    harness.runTimers();
    await harness.settle();

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ endpoint: '/character/dye/clear' });
  });

  it('starts the timer-fired newest set during pagehide while an earlier set is in flight', () => {
    const harness = createWardrobeHarness();
    const first = deferred<ResponseLike>();
    harness.responses.push(first);

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    harness.pagehide();

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1].body.toString()).toBe('token=test-token&slot=1&recipe=wheel&hue=12&tone=0&session=900&revision=1001');
    first.resolve({ ok: true });
  });

  it('starts a queued clear during pagehide while its earlier set is in flight', () => {
    const harness = createWardrobeHarness();
    const first = deferred<ResponseLike>();
    harness.responses.push(first);

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    harness.defaultButton.dispatch('click');
    harness.pagehide();

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]).toMatchObject({ endpoint: '/character/dye/clear' });
    expect(harness.requests[1].body.toString()).toBe('token=test-token&slot=1&session=900&revision=1001');
    first.resolve({ ok: true });
  });

  it('settles only after the tracked beforeunload duplicate when the original save finishes first', async () => {
    const harness = createWardrobeHarness();
    const original = deferred<ResponseLike>();
    const duplicate = deferred<ResponseLike>();
    harness.responses.push(original, duplicate);

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    harness.beforeunload(); // Simulate a canceled navigation that returns to the page.
    original.resolve({ ok: true });
    await harness.settle();
    expect(harness.status.textContent).toBe('Saving…');

    duplicate.resolve({ ok: true });
    await harness.settle();
    expect(harness.status.textContent).toBe('All changes saved');

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    await harness.settle();
    expect(harness.requests).toHaveLength(3);
  });

  it('does not let a late original save disturb a settled beforeunload duplicate', async () => {
    const harness = createWardrobeHarness();
    const original = deferred<ResponseLike>();
    const duplicate = deferred<ResponseLike>();
    harness.responses.push(original, duplicate);

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    harness.beforeunload(); // The navigation is canceled and the page remains usable.
    duplicate.resolve({ ok: true });
    await harness.settle();
    expect(harness.status.textContent).toBe('All changes saved');

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    await harness.settle();
    expect(harness.requests).toHaveLength(3);

    original.resolve({ ok: true });
    await harness.settle();
    expect(harness.status.textContent).toBe('All changes saved');
  });

  it('marks only the failed channel and clears its marker after a successful retry', async () => {
    const harness = createWardrobeHarness();
    const failed = deferred<ResponseLike>();
    harness.responses.push(failed);

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    failed.resolve({ ok: false });
    await harness.settle();

    expect(harness.clothing.classList.contains('save-failed')).toBe(true);
    expect(harness.clothing.getAttribute('aria-invalid')).toBe('true');
    expect(harness.cloak.classList.contains('save-failed')).toBe(false);

    pressWheel(harness, 'ArrowRight');
    harness.runTimers();
    await harness.settle();

    expect(harness.clothing.classList.contains('save-failed')).toBe(false);
    expect(harness.clothing.getAttribute('aria-invalid')).toBe('false');
  });

  it('uses Tone-aware shared color math for channel dots', () => {
    const black = createWardrobeHarness({ 1: { op: 'colorize', hue: 0, sat: 0.6, tone: -1 } });
    const white = createWardrobeHarness({ 1: { op: 'colorize', hue: 0, sat: 0.6, tone: 1 } });

    expect(black.clothing.dot.style.background).toBe('rgb(74 74 74)');
    expect(white.clothing.dot.style.background).toBe('rgb(249 249 249)');
  });
});
