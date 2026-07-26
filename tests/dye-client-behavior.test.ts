import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;
type Rule = Record<string, number | string>;
type ResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<{ config: Record<number, Rule>; hash: string }>;
};

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
  value = '';
  disabled = false;
  hidden = false;
  src = '';

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

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
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
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function response(config: Record<number, Rule> = {}): ResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ config, hash: '0123456789abcdef' }),
  };
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
  tone: FakeElement;
  status: FakeElement;
  steelButton: FakeButton;
  defaultButton: FakeButton;
  saveButton: FakeButton;
  discardButton: FakeButton;
  reloadButton: FakeButton;
  requests: RequestRecord[];
  responses: Array<Deferred<ResponseLike>>;
  beforeunload(): { prevented: boolean; returnValue: string | undefined };
  pageshow(persisted: boolean): void;
  reloadCount(): number;
  settle(): Promise<void>;
}

function createWardrobeHarness(config: Record<number, Rule> = {}): WardrobeHarness {
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
  tone.value = '0';
  const toneValue = new FakeElement();
  const status = new FakeElement();
  const activeLabel = new FakeElement();
  const steelButton = new FakeButton(['dye-fin']);
  steelButton.dataset.recipe = 'steel';
  const defaultButton = new FakeButton(['dye-fin']);
  defaultButton.dataset.recipe = 'none';
  const saveButton = new FakeButton();
  saveButton.disabled = true;
  const discardButton = new FakeButton();
  discardButton.disabled = true;
  const reloadButton = new FakeButton();
  reloadButton.hidden = true;
  const elements = new Map<string, FakeElement>([
    ['dye-preview', preview], ['dye-wheel', wheel], ['dye-save-status', status],
    ['dye-active-label', activeLabel], ['dye-tone', tone], ['dye-tone-value', toneValue],
    ['dye-save', saveButton], ['dye-discard', discardButton], ['dye-reload', reloadButton],
  ]);
  const windowListeners = new Map<string, Listener[]>();
  const requests: RequestRecord[] = [];
  const responses: Array<Deferred<ResponseLike>> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let reloads = 0;
  const document = {
    getElementById(id: string): FakeElement | null { return elements.get(id) ?? null; },
    createElement(tag: string): FakeElement { return tag === 'canvas' ? new FakeCanvas(24, 24) : new FakeElement(); },
    querySelectorAll(selector: string): FakeButton[] {
      if (selector === '.dye-chan:not(:disabled)') return [clothing, cloak];
      if (selector === '.dye-fin') return [steelButton, defaultButton];
      return [];
    },
  };
  const context: Record<string, unknown> = {
    document,
    Image: FakeImage,
    URLSearchParams,
    setTimeout(callback: () => void) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(endpoint: string, options: { body: URLSearchParams }) {
      requests.push({ endpoint, body: new URLSearchParams(options.body.toString()) });
      const next = responses.shift();
      return next ? next.promise : Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ config: {}, hash: '0123456789abcdef' }),
      });
    },
    addEventListener(type: string, listener: Listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    location: { reload() { reloads += 1; } },
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
  vm.runInNewContext(readFileSync('src/web/public/dye-draft.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('src/web/public/dye.js', 'utf8'), context);

  return {
    clothing, cloak, weapon, wheel, tone, status, steelButton, defaultButton,
    saveButton, discardButton, reloadButton, requests, responses,
    beforeunload() {
      let prevented = false;
      const event = {
        returnValue: undefined as string | undefined,
        preventDefault() { prevented = true; },
      };
      for (const listener of windowListeners.get('beforeunload') ?? []) listener(event);
      return { prevented, returnValue: event.returnValue };
    },
    pageshow(persisted: boolean) {
      for (const listener of windowListeners.get('pageshow') ?? []) listener({ persisted });
    },
    reloadCount() { return reloads; },
    async settle() {
      await Promise.resolve();
      await Promise.resolve();
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

function changes(request: RequestRecord): unknown {
  return JSON.parse(request.body.get('changes') ?? 'null');
}

describe('dye browser Wardrobe behavior', () => {
  it('initializes against the rendered tier groups, switches enabled channels, and leaves locked channels inert', () => {
    const harness = createWardrobeHarness();

    expect(harness.clothing.classList.contains('active')).toBe(true);
    harness.cloak.dispatch('click');
    expect(harness.cloak.classList.contains('active')).toBe(true);
    harness.weapon.dispatch('click');
    expect(harness.cloak.classList.contains('active')).toBe(true);
    expect(harness.status.textContent).toBe('Saved');
  });

  it('keeps hue and Tone dragging local and reports one stable unsaved state', () => {
    const harness = createWardrobeHarness();

    pressWheel(harness, 'ArrowRight');
    expect(harness.status.textContent).toBe('Unsaved changes');
    pressWheel(harness, 'ArrowRight');
    harness.tone.value = '25';
    harness.tone.dispatch('input');

    expect(harness.requests).toHaveLength(0);
    expect(harness.status.textContent).toBe('Unsaved changes');
    expect(harness.saveButton.disabled).toBe(false);
    expect(harness.discardButton.disabled).toBe(false);
  });

  it('sends all dirty channels in one batch and disables both actions while saving', async () => {
    const harness = createWardrobeHarness();
    const pending = deferred<ResponseLike>();
    harness.responses.push(pending);

    pressWheel(harness, 'ArrowRight');
    harness.cloak.dispatch('click');
    harness.steelButton.dispatch('click');
    harness.saveButton.dispatch('click');

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].endpoint).toBe('/character/dye/save');
    expect(harness.requests[0].body.get('token')).toBe('test-token');
    expect(harness.requests[0].body.get('session')).toBe('900');
    expect(harness.requests[0].body.get('revision')).toBe('1000');
    expect(changes(harness.requests[0])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
      { action: 'set', slot: 2, recipe: 'steel', tone: 0 },
    ]);
    expect(harness.saveButton.disabled).toBe(true);
    expect(harness.discardButton.disabled).toBe(true);

    pending.resolve(response({
      1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 },
      2: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 },
    }));
    await harness.settle();
    expect(harness.status.textContent).toBe('Saved');
    expect(harness.saveButton.disabled).toBe(true);
    expect(harness.discardButton.disabled).toBe(true);
  });

  it('uses the successful canonical response as the next saved baseline', async () => {
    const harness = createWardrobeHarness();
    const pending = deferred<ResponseLike>();
    harness.responses.push(pending);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    pending.resolve(response({
      1: { op: 'colorize', hue: 120, sat: 0.6, tone: 0.25 },
    }));
    await harness.settle();

    expect(harness.status.textContent).toBe('Saved');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('120');
    expect(harness.tone.value).toBe('25');
    pressWheel(harness, 'ArrowRight');
    harness.discardButton.dispatch('click');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('120');
    expect(harness.tone.value).toBe('25');
    expect(harness.status.textContent).toBe('Saved');
  });

  it('discards every edited channel back to its saved rule without a request', () => {
    const harness = createWardrobeHarness({
      1: { op: 'colorize', hue: 20, sat: 0.6, tone: 0.1 },
      2: { op: 'colorize', hue: 212, sat: 0.13, tone: -0.2 },
    });

    pressWheel(harness, 'ArrowRight');
    harness.cloak.dispatch('click');
    harness.tone.value = '40';
    harness.tone.dispatch('input');
    harness.discardButton.dispatch('click');

    expect(harness.requests).toHaveLength(0);
    expect(harness.status.textContent).toBe('Saved');
    expect(harness.tone.value).toBe('-20');
    harness.clothing.dispatch('click');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('20');
    expect(harness.tone.value).toBe('10');
  });

  it('stages Restore Default as one clear without saving automatically', () => {
    const harness = createWardrobeHarness({
      1: { op: 'colorize', hue: 20, sat: 0.6, tone: 0 },
    });

    harness.defaultButton.dispatch('click');
    expect(harness.requests).toHaveLength(0);
    expect(harness.status.textContent).toBe('Unsaved changes');

    harness.saveButton.dispatch('click');
    expect(harness.requests).toHaveLength(1);
    expect(changes(harness.requests[0])).toEqual([{ action: 'clear', slot: 1 }]);
  });

  it('preserves the draft and enables retry after an ordinary request failure', async () => {
    const harness = createWardrobeHarness();
    const pending = deferred<ResponseLike>();
    harness.responses.push(pending);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    pending.reject(new Error('offline'));
    await harness.settle();

    expect(harness.status.textContent).toBe('Save failed');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('6');
    expect(harness.saveButton.disabled).toBe(false);
    expect(harness.discardButton.disabled).toBe(false);
    expect(harness.requests).toHaveLength(1);
  });

  it('keeps a stale draft visible, blocks further saves, and reveals Reload Wardrobe', async () => {
    const harness = createWardrobeHarness();
    const pending = deferred<ResponseLike>();
    harness.responses.push(pending);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    pending.resolve({
      ok: false,
      status: 409,
      json: async () => ({ config: {}, hash: '0123456789abcdef' }),
    });
    await harness.settle();

    expect(harness.status.textContent).toBe('Wardrobe changed elsewhere — refresh required');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('6');
    expect(harness.saveButton.disabled).toBe(true);
    expect(harness.discardButton.disabled).toBe(true);
    expect(harness.reloadButton.hidden).toBe(false);
    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    expect(harness.requests).toHaveLength(1);
    expect(harness.saveButton.disabled).toBe(true);
    harness.reloadButton.dispatch('click');
    expect(harness.reloadCount()).toBe(1);
  });

  it('warns before unload only while the draft is dirty', () => {
    const harness = createWardrobeHarness();

    expect(harness.beforeunload()).toEqual({ prevented: false, returnValue: undefined });
    pressWheel(harness, 'ArrowRight');
    expect(harness.beforeunload()).toEqual({ prevented: true, returnValue: '' });
    expect(harness.requests).toHaveLength(0);
  });

  it('reloads a restored bfcache page once and ignores normal pageshow', () => {
    const harness = createWardrobeHarness();

    harness.pageshow(false);
    expect(harness.reloadCount()).toBe(0);
    harness.pageshow(true);
    expect(harness.reloadCount()).toBe(1);
  });

  it('uses Tone-aware shared color math for channel dots', () => {
    const black = createWardrobeHarness({ 1: { op: 'colorize', hue: 0, sat: 0.6, tone: -1 } });
    const white = createWardrobeHarness({ 1: { op: 'colorize', hue: 0, sat: 0.6, tone: 1 } });

    expect(black.clothing.dot.style.background).toBe('rgb(74 74 74)');
    expect(white.clothing.dot.style.background).toBe('rgb(249 249 249)');
  });
});
