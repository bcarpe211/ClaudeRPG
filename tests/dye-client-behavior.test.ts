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
  sourceSeed = 0;
  readonly drawnCanvases: FakeCanvas[] = [];
  readonly outputs: Uint8ClampedArray[] = [];
  clearRect(): void {}
  fillRect(): void {}
  drawImage(source: FakeCanvas | FakeImage): void {
    if (source instanceof FakeCanvas) this.drawnCanvases.push(source);
    else this.sourceSeed = source.src.includes('frame-b') ? 180 : 80;
  }
  putImageData(image: { data: Uint8ClampedArray }): void {
    this.outputs.push(new Uint8ClampedArray(image.data));
  }
  createImageData(width: number, height: number): { data: Uint8ClampedArray } {
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
  getImageData(_x: number, _y: number, width: number, height: number): { data: Uint8ClampedArray } {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const index = pixel * 4;
      data[index] = this.sourceSeed;
      data[index + 1] = 40;
      data[index + 2] = 20;
      data[index + 3] = 255;
    }
    return { data };
  }
}

class FakeCanvas extends FakeElement {
  width: number;
  height: number;
  readonly context = new FakeContext();

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
  toDataURL(): string {
    const data = this.context.outputs.at(-1);
    return data ? `data:image/png;base64,${Array.from(data.slice(0, 8)).join('-')}` : 'data:image/png;base64,empty';
  }
}

class FakeImage {
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';

  load(): void { this.onload?.(); }
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

function failedResponse(status: number): ResponseLike {
  return {
    ok: false,
    status,
    json: async () => ({ config: {}, hash: '0123456789abcdef' }),
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
  bronzeButton: FakeButton;
  goldButton: FakeButton;
  defaultButton: FakeButton;
  profileA: FakeElement;
  profileB: FakeElement;
  saveButton: FakeButton;
  discardButton: FakeButton;
  reloadButton: FakeButton;
  requests: RequestRecord[];
  responses: Array<Deferred<ResponseLike>>;
  beforeunload(): { prevented: boolean; returnValue: string | undefined };
  pageshow(persisted: boolean): void;
  reloadCount(): number;
  loadedSources(): string[];
  loadFrames(): void;
  advanceAnimation(): void;
  previewFrames(): FakeCanvas[];
  frameOutputs(): Uint8ClampedArray[][];
  canvasCount(): number;
  selectedBubble(): FakeElement | null;
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
  const steelButton = new FakeButton(['dye-fin']);
  steelButton.dataset.recipe = 'steel';
  const bronzeButton = new FakeButton(['dye-fin']);
  bronzeButton.dataset.recipe = 'bronze';
  const goldButton = new FakeButton(['dye-fin']);
  goldButton.dataset.recipe = 'gold';
  const defaultButton = new FakeButton(['dye-fin']);
  defaultButton.dataset.recipe = 'none';
  const profileA = new FakeElement(['px', 'frame-a']);
  const profileB = new FakeElement(['px', 'frame-b']);
  const saveButton = new FakeButton();
  saveButton.disabled = true;
  const discardButton = new FakeButton();
  discardButton.disabled = true;
  const reloadButton = new FakeButton();
  reloadButton.hidden = true;
  const elements = new Map<string, FakeElement>([
    ['dye-preview', preview], ['dye-wheel', wheel], ['dye-save-status', status],
    ['dye-tone', tone], ['dye-tone-value', toneValue],
    ['dye-save', saveButton], ['dye-discard', discardButton], ['dye-reload', reloadButton],
    ['character-avatar-a', profileA], ['character-avatar-b', profileB],
  ]);
  const windowListeners = new Map<string, Listener[]>();
  const requests: RequestRecord[] = [];
  const responses: Array<Deferred<ResponseLike>> = [];
  const timers = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const images: FakeImage[] = [];
  const createdCanvases: FakeCanvas[] = [];
  let nextTimer = 0;
  let reloads = 0;
  const document = {
    getElementById(id: string): FakeElement | null { return elements.get(id) ?? null; },
    createElement(tag: string): FakeElement {
      if (tag !== 'canvas') return new FakeElement();
      const canvas = new FakeCanvas(24, 24);
      createdCanvases.push(canvas);
      return canvas;
    },
    querySelectorAll(selector: string): FakeButton[] {
      if (selector === '.dye-chan:not(:disabled)') return [clothing, cloak];
      if (selector === '.dye-fin') return [steelButton, bronzeButton, goldButton, defaultButton];
      return [];
    },
  };
  class HarnessImage extends FakeImage {
    constructor() {
      super();
      images.push(this);
    }
  }
  const frameASlotmap = Array<number>(24 * 24).fill(0);
  const frameBSlotmap = Array<number>(24 * 24).fill(0);
  frameASlotmap[0] = 1;
  frameBSlotmap[1] = 1;
  const context: Record<string, unknown> = {
    document,
    Image: HarnessImage,
    URLSearchParams,
    setTimeout(callback: () => void) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(callback: () => void) {
      const id = ++nextTimer;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id: number) { intervals.delete(id); },
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
      token: 'test-token',
      frames: {
        a: { base: '/frame-a.png', slotmap: frameASlotmap },
        b: { base: '/frame-b.png', slotmap: frameBSlotmap },
      },
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
    clothing, cloak, weapon, wheel, tone, status, steelButton, bronzeButton, goldButton, defaultButton,
    profileA, profileB,
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
    loadedSources() { return images.map((image) => image.src); },
    loadFrames() { for (const image of images) image.load(); },
    advanceAnimation() { for (const callback of intervals.values()) callback(); },
    previewFrames() { return [...preview.context.drawnCanvases]; },
    frameOutputs() { return createdCanvases.map((canvas) => [...canvas.context.outputs]); },
    canvasCount() { return createdCanvases.length; },
    selectedBubble() { return document.getElementById('dye-active-label'); },
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
  it('loads, renders, and alternates both frame sources without timer allocations', () => {
    const harness = createWardrobeHarness();

    expect(harness.loadedSources()).toEqual(['/frame-a.png', '/frame-b.png']);
    expect(harness.selectedBubble()).toBeNull();
    harness.loadFrames();
    expect(harness.previewFrames().at(-1)).toBe(harness.previewFrames()[0]);
    const canvasesBeforeTick = harness.canvasCount();

    harness.advanceAnimation();

    expect(harness.previewFrames().at(-1)).not.toBe(harness.previewFrames()[0]);
    expect(harness.canvasCount()).toBe(canvasesBeforeTick);
  });

  it('applies one draft through each frame source and its frame-specific slot map', () => {
    const harness = createWardrobeHarness();
    harness.loadFrames();
    const before = harness.frameOutputs().map((outputs) => outputs.at(-1)!);

    pressWheel(harness, 'ArrowRight');

    const after = harness.frameOutputs().map((outputs) => outputs.at(-1)!);
    expect(Array.from(after[0].slice(0, 4))).not.toEqual(Array.from(before[0].slice(0, 4)));
    expect(Array.from(after[0].slice(4, 8))).toEqual(Array.from(before[0].slice(4, 8)));
    expect(Array.from(after[1].slice(0, 4))).toEqual(Array.from(before[1].slice(0, 4)));
    expect(Array.from(after[1].slice(4, 8))).not.toEqual(Array.from(before[1].slice(4, 8)));
    expect(harness.profileA.src).not.toBe(harness.profileB.src);
  });

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
    expect(harness.status.textContent).toBe('Saving');
    expect(harness.status.dataset.state).toBe('saving');

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

  it('rebases edits made while Save is in flight onto the canonical response', async () => {
    const harness = createWardrobeHarness();
    const first = deferred<ResponseLike>();
    const second = deferred<ResponseLike>();
    harness.responses.push(first, second);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    expect(changes(harness.requests[0])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
    ]);
    expect(harness.wheel.disabled).toBe(false);
    expect(harness.tone.disabled).toBe(false);
    expect(harness.steelButton.disabled).toBe(false);
    expect(harness.clothing.disabled).toBe(false);
    expect(harness.cloak.disabled).toBe(false);

    pressWheel(harness, 'ArrowRight');
    first.resolve(response({
      1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 },
    }));
    await harness.settle();

    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('12');
    expect(harness.status.textContent).toBe('Unsaved changes');
    expect(harness.saveButton.disabled).toBe(false);
    expect(harness.discardButton.disabled).toBe(false);

    harness.saveButton.dispatch('click');
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1].body.get('revision')).toBe('1001');
    expect(changes(harness.requests[1])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 12, tone: 0 },
    ]);

    second.resolve(response({
      1: { op: 'colorize', hue: 12, sat: 0.6, tone: 0 },
    }));
    await harness.settle();
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
    expect(harness.status.dataset.state).toBe('error');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('6');
    expect(harness.saveButton.disabled).toBe(false);
    expect(harness.discardButton.disabled).toBe(false);
    expect(harness.requests).toHaveLength(1);
  });

  it('preserves the exact pending attempt for retry after a 5xx response', async () => {
    const harness = createWardrobeHarness();
    const failed = deferred<ResponseLike>();
    const retry = deferred<ResponseLike>();
    harness.responses.push(failed, retry);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    failed.resolve(failedResponse(503));
    await harness.settle();

    expect(harness.status.textContent).toBe('Save failed');
    expect(harness.saveButton.disabled).toBe(false);
    harness.saveButton.dispatch('click');
    expect(harness.requests[1].body.get('revision')).toBe('1000');
    expect(changes(harness.requests[1])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
    ]);

    retry.resolve(response({
      1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 },
    }));
    await harness.settle();
    expect(harness.status.textContent).toBe('Saved');
  });

  it.each([
    [400, 'Wardrobe save was rejected — refresh required'],
    [403, 'Wardrobe access changed — refresh required'],
    [404, 'Character session expired — reload required'],
  ])('treats HTTP %i as definitive and requires reload without retrying', async (statusCode, message) => {
    const harness = createWardrobeHarness();
    const failed = deferred<ResponseLike>();
    harness.responses.push(failed);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    failed.resolve(failedResponse(statusCode));
    await harness.settle();

    expect(harness.status.textContent).toBe(message);
    expect(harness.status.dataset.state).toBe('error');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('6');
    expect(harness.saveButton.disabled).toBe(true);
    expect(harness.discardButton.disabled).toBe(true);
    expect(harness.reloadButton.hidden).toBe(false);
    harness.saveButton.dispatch('click');
    expect(harness.requests).toHaveLength(1);
    expect(harness.beforeunload()).toEqual({ prevented: true, returnValue: '' });
  });

  it('retries an ambiguous failed attempt unchanged and rebases newer same-slot edits', async () => {
    const harness = createWardrobeHarness();
    const lostResponse = deferred<ResponseLike>();
    const retry = deferred<ResponseLike>();
    const finalSave = deferred<ResponseLike>();
    harness.responses.push(lostResponse, retry, finalSave);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    expect(changes(harness.requests[0])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
    ]);
    lostResponse.reject(new Error('response lost after commit'));
    await harness.settle();

    pressWheel(harness, 'ArrowRight');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('12');
    harness.saveButton.dispatch('click');

    expect(harness.requests[1].body.get('revision')).toBe('1000');
    expect(changes(harness.requests[1])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
    ]);
    retry.resolve(response({
      1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 },
    }));
    await harness.settle();

    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('12');
    expect(harness.status.textContent).toBe('Unsaved changes');
    expect(harness.status.dataset.state).toBe('dirty');

    harness.saveButton.dispatch('click');
    expect(harness.requests[2].body.get('revision')).toBe('1001');
    expect(changes(harness.requests[2])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 12, tone: 0 },
    ]);
    finalSave.resolve(response({
      1: { op: 'colorize', hue: 12, sat: 0.6, tone: 0 },
    }));
    await harness.settle();
    expect(harness.status.textContent).toBe('Saved');
    expect(harness.status.dataset.state).toBe('saved');
  });

  it('discards to the acknowledged look while retaining an ambiguous attempt for retry', async () => {
    const harness = createWardrobeHarness();
    const lostResponse = deferred<ResponseLike>();
    const retry = deferred<ResponseLike>();
    harness.responses.push(lostResponse, retry);

    pressWheel(harness, 'ArrowRight');
    harness.saveButton.dispatch('click');
    lostResponse.reject(new Error('response lost after commit'));
    await harness.settle();

    harness.discardButton.dispatch('click');
    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('0');
    expect(harness.status.textContent).toBe('Save failed');
    expect(harness.saveButton.disabled).toBe(false);

    harness.saveButton.dispatch('click');
    expect(harness.requests[1].body.get('revision')).toBe('1000');
    expect(changes(harness.requests[1])).toEqual([
      { action: 'set', slot: 1, recipe: 'wheel', hue: 6, tone: 0 },
    ]);
    retry.resolve(response({
      1: { op: 'colorize', hue: 6, sat: 0.6, tone: 0 },
    }));
    await harness.settle();

    expect(harness.wheel.getAttribute('aria-valuenow')).toBe('0');
    expect(harness.status.textContent).toBe('Unsaved changes');
    expect(harness.status.dataset.state).toBe('dirty');
    harness.saveButton.dispatch('click');
    expect(harness.requests[2].body.get('revision')).toBe('1001');
    expect(changes(harness.requests[2])).toEqual([{ action: 'clear', slot: 1 }]);
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

  it('reapplies canonical controls after normal pageshow form restoration', () => {
    const harness = createWardrobeHarness();

    harness.tone.value = '90';
    harness.pageshow(false);
    expect(harness.tone.value).toBe('0');
    expect(harness.reloadCount()).toBe(0);
  });

  it('reloads a restored bfcache page once', () => {
    const harness = createWardrobeHarness();

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
