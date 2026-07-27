import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: FakeSubmitEvent) => void;

class FakeSubmitEvent {
  defaultPrevented = false;

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? '';
  }
}

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly style = new FakeStyle();
  className = '';
  textContent = '';
  src = '';
  alt = '';

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeButton extends FakeElement {
  disabled = false;

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 240, top: 320, width: 160, height: 44 };
  }
}

class FakeHTMLFormElement extends FakeElement {
  readonly button = new FakeButton();
  readonly listeners = new Map<string, Listener[]>();
  nativeSubmitCount = 0;
  shadowSubmitCount = 0;

  constructor() {
    super();
    Object.defineProperty(this, 'submit', {
      value: () => { this.shadowSubmitCount += 1; },
      configurable: true,
    });
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  querySelector(selector: string): FakeButton | null {
    return selector === 'button' ? this.button : null;
  }

  dispatchSubmit(): FakeSubmitEvent {
    const event = new FakeSubmitEvent();
    for (const listener of this.listeners.get('submit') ?? []) listener(event);
    return event;
  }

  submit(): void {
    this.nativeSubmitCount += 1;
  }
}

interface ShopHarness {
  form: FakeHTMLFormElement;
  body: FakeElement;
  timers: Array<{ callback: () => void; delay: number }>;
}

function createShopHarness(options: { reducedMotion?: boolean; enhanced?: boolean } = {}): ShopHarness {
  const form = new FakeHTMLFormElement();
  const body = new FakeElement();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const document = {
    body,
    querySelector(selector: string): FakeHTMLFormElement | null {
      if (selector !== 'form[data-purchase-effect]' || options.enhanced === false) return null;
      return form;
    },
    createElement(): FakeElement {
      return new FakeElement();
    },
  };
  const context: Record<string, unknown> = {
    document,
    HTMLFormElement: FakeHTMLFormElement,
    matchMedia(query: string) {
      expect(query).toBe('(prefers-reduced-motion: reduce)');
      return { matches: options.reducedMotion === true };
    },
    setTimeout(callback: () => void, delay: number) {
      timers.push({ callback, delay });
      return timers.length;
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync('src/web/public/shop.js', 'utf8'), context);
  return { form, body, timers };
}

function burstImages(harness: ShopHarness): FakeElement[] {
  return harness.body.children[0]?.children ?? [];
}

describe('Bazaar purchase celebration', () => {
  it('locks the first submit and invokes the native form submission once after 1200ms', () => {
    const harness = createShopHarness();

    const event = harness.form.dispatchSubmit();

    expect(event.defaultPrevented).toBe(true);
    expect(harness.form.button.disabled).toBe(true);
    expect(harness.form.button.getAttribute('aria-busy')).toBe('true');
    expect(harness.form.button.textContent).toBe('Forging…');
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].delay).toBe(1200);
    expect(harness.form.nativeSubmitCount).toBe(0);

    harness.timers[0].callback();
    expect(harness.form.nativeSubmitCount).toBe(1);
    expect(harness.form.shadowSubmitCount).toBe(0);
  });

  it('guards a second submit without scheduling another purchase', () => {
    const harness = createShopHarness();
    harness.form.dispatchSubmit();

    const duplicate = harness.form.dispatchSubmit();

    expect(duplicate.defaultPrevented).toBe(true);
    expect(harness.timers).toHaveLength(1);
    expect(burstImages(harness)).toHaveLength(5);
    harness.timers[0].callback();
    expect(harness.form.nativeSubmitCount).toBe(1);
  });

  it('creates the five approved sprites with deterministic distinct flight vectors', () => {
    const harness = createShopHarness();

    harness.form.dispatchSubmit();

    expect(harness.body.children).toHaveLength(1);
    expect(harness.body.children[0].classList.contains('purchase-burst')).toBe(true);
    const sprites = burstImages(harness);
    expect(sprites.map((sprite) => sprite.src)).toEqual([
      '/static/landing/potion.png',
      '/static/landing/sword.png',
      '/static/landing/shield.png',
      '/static/landing/coins.png',
      '/static/landing/gem_purple.png',
    ]);
    expect(sprites.every((sprite) => sprite.alt === '' && sprite.getAttribute('aria-hidden') === 'true')).toBe(true);
    const flights = sprites.map((sprite) => [
      sprite.style.getPropertyValue('--burst-x'),
      sprite.style.getPropertyValue('--burst-y'),
      sprite.style.getPropertyValue('--burst-r'),
      sprite.style.getPropertyValue('--burst-delay'),
    ].join('|'));
    expect(new Set(flights).size).toBe(5);
  });

  it('submits immediately without moving sprites when reduced motion is requested', () => {
    const harness = createShopHarness({ reducedMotion: true });

    const event = harness.form.dispatchSubmit();

    expect(event.defaultPrevented).toBe(true);
    expect(harness.form.button.disabled).toBe(true);
    expect(harness.form.button.getAttribute('aria-busy')).toBe('true');
    expect(harness.form.button.textContent).toBe('Forging…');
    expect(harness.body.children).toHaveLength(0);
    expect(harness.timers).toHaveLength(0);
    expect(harness.form.nativeSubmitCount).toBe(1);
    expect(harness.form.shadowSubmitCount).toBe(0);
  });

  it('leaves ordinary HTML submission untouched when the enhancement hook is absent', () => {
    const harness = createShopHarness({ enhanced: false });

    const event = harness.form.dispatchSubmit();

    expect(event.defaultPrevented).toBe(false);
    expect(harness.form.button.disabled).toBe(false);
    expect(harness.timers).toHaveLength(0);
    expect(harness.body.children).toHaveLength(0);
  });
});
