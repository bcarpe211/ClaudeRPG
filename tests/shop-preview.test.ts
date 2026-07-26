import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

interface SlotRule {
  op: string;
  hue?: number;
  sat?: number;
  tone?: number;
  lo?: number;
  hi?: number;
}

interface ShopPreviewApi {
  hueAt(timeMs: number, demoIndex: number): number;
  demoRuleFor(
    slot: number,
    demoSlots: number[],
    savedConfig: Record<number, SlotRule>,
    timeMs: number,
  ): SlotRule | null;
}

let api: ShopPreviewApi;

beforeEach(() => {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync('src/web/public/shop-preview.js', 'utf8'), context);
  api = context.ClaudeRpgShopPreview as ShopPreviewApi;
});

describe('shop next-offer preview helpers', () => {
  it('gives simultaneous demo slots deterministic independent palettes', () => {
    expect(api.hueAt(0, 0)).not.toBe(api.hueAt(0, 1));
    expect(api.hueAt(1_337, 2)).toBe(api.hueAt(1_337, 2));
  });

  it('repeats every demo slot at its own documented prime-number duration', () => {
    const durations = [5300, 6100, 7100, 7900, 8900];
    for (const [index, duration] of durations.entries()) {
      expect(api.hueAt(duration, index)).toBeCloseTo(api.hueAt(0, index), 8);
    }
  });

  it('crosses the hue boundary through 359 and 0 instead of taking the long path', () => {
    const justBeforeWrap = api.hueAt(5300 * 0.95, 0);
    const justAfterWrap = api.hueAt(5300 * 0.98, 0);

    expect(justBeforeWrap).toBeGreaterThan(350);
    expect(justAfterWrap).toBeLessThan(10);
  });

  it('keeps saved rules on non-demo slots and colorizes demo slots temporarily', () => {
    const savedRule = { op: 'value', lo: 0, hi: 0.32 };
    const savedConfig = { 1: savedRule };

    expect(api.demoRuleFor(1, [2], savedConfig, 900)).toBe(savedRule);
    expect(api.demoRuleFor(3, [2], savedConfig, 900)).toBeNull();
    expect(api.demoRuleFor(2, [2], savedConfig, 900)).toMatchObject({
      op: 'colorize',
      hue: api.hueAt(900, 0),
      sat: 0.6,
      tone: 0,
    });
  });

  it('animates locally at no more than 12 FPS while switching source frames every 700ms', () => {
    const source = readFileSync('src/web/public/shop-preview.js', 'utf8');
    const appliedRules: SlotRule[] = [];
    let fetchCalls = 0;
    let animationFrame: ((timeMs: number) => void) | null = null;

    class FakeImage {
      crossOrigin = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private value = '';

      get src(): string { return this.value; }
      set src(value: string) {
        this.value = value;
        this.onload?.();
      }
    }

    class FakeContext {
      imageSmoothingEnabled = true;
      sourceSeed = 0;
      readonly outputs: Uint8ClampedArray[] = [];

      clearRect(): void {}
      drawImage(image: FakeImage): void {
        this.sourceSeed = image.src.includes('frame-b') ? 160 : 80;
      }
      getImageData(): { data: Uint8ClampedArray } {
        const data = new Uint8ClampedArray(24 * 24 * 4);
        for (let pixel = 0; pixel < 24 * 24; pixel += 1) {
          const offset = pixel * 4;
          data[offset] = this.sourceSeed;
          data[offset + 1] = 40;
          data[offset + 2] = 20;
          data[offset + 3] = 255;
        }
        return { data };
      }
      createImageData(): { data: Uint8ClampedArray } {
        return { data: new Uint8ClampedArray(24 * 24 * 4) };
      }
      putImageData(image: { data: Uint8ClampedArray }): void {
        this.outputs.push(new Uint8ClampedArray(image.data));
      }
    }

    class FakeCanvas {
      width = 24;
      height = 24;
      readonly context = new FakeContext();
      getContext(): FakeContext { return this.context; }
    }

    const visibleCanvas = new FakeCanvas();
    const frameA = new Array<number>(24 * 24).fill(0);
    const frameB = new Array<number>(24 * 24).fill(0);
    frameA[0] = 1;
    frameA[1] = 2;
    frameB[0] = 1;
    frameB[1] = 3;
    const context = {
      __SHOP_PREVIEW__: {
        frames: {
          a: { base: '/frame-a.png', slotmap: frameA },
          b: { base: '/frame-b.png', slotmap: frameB },
        },
        config: { 1: { op: 'value', lo: 0, hi: 0.32 } },
        demoSlots: [2, 3],
      },
      ClaudeRpgDyeColor: {
        applyRule(rule: SlotRule, red: number, green: number, blue: number): number[] {
          appliedRules.push(rule);
          return [rule.hue ?? red, green, blue];
        },
      },
      document: {
        getElementById(id: string): FakeCanvas | null {
          return id === 'shop-preview' ? visibleCanvas : null;
        },
        createElement(tag: string): FakeCanvas {
          if (tag !== 'canvas') throw new Error(`Unexpected element ${tag}`);
          return new FakeCanvas();
        },
      },
      Image: FakeImage,
      requestAnimationFrame(callback: (timeMs: number) => void): number {
        animationFrame = callback;
        return 1;
      },
      fetch(): never {
        fetchCalls += 1;
        throw new Error('The shop preview must not use fetch');
      },
    };

    vm.runInNewContext(source, context);
    const tick = (timeMs: number) => {
      const callback = animationFrame as ((timeMs: number) => void) | null;
      expect(callback).not.toBeNull();
      animationFrame = null;
      callback?.(timeMs);
    };

    tick(0);
    expect(visibleCanvas.context.outputs).toHaveLength(1);
    expect(appliedRules[0]).toMatchObject({ op: 'value', lo: 0, hi: 0.32 });
    expect(appliedRules[1]).toMatchObject({ op: 'colorize', hue: 8, sat: 0.6 });

    tick(50);
    expect(visibleCanvas.context.outputs).toHaveLength(1);
    tick(84);
    expect(visibleCanvas.context.outputs).toHaveLength(2);

    tick(700);
    expect(visibleCanvas.context.outputs).toHaveLength(3);
    expect(visibleCanvas.context.outputs.at(-1)?.[0]).not.toBe(
      visibleCanvas.context.outputs[0][0],
    );
    expect(appliedRules.at(-1)).toMatchObject({
      op: 'colorize',
      hue: api.hueAt(700, 1),
      sat: 0.6,
    });
    expect(fetchCalls).toBe(0);
  });
});
