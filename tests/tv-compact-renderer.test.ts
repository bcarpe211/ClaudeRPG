import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface PathFill {
  color: string;
  bounds: Bounds;
}

interface TextDraw {
  text: string;
  color: string;
  baseline: number;
  fontPx: number;
}

interface ImageDraw {
  source: FakeCanvas | FakeImage;
  bounds: Bounds;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function boundsFromEdges(left: number, top: number, right: number, bottom: number): Bounds {
  return {
    left: rounded(left),
    top: rounded(top),
    right: rounded(right),
    bottom: rounded(bottom),
    width: rounded(right - left),
    height: rounded(bottom - top),
  };
}

class FakeImage {
  complete = true;
  naturalWidth = 24;
  src = '';
  onload: null | (() => void) = null;
}

class RecordingContext {
  fillStyle = '';
  strokeStyle = '';
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  imageSmoothingEnabled = true;
  globalAlpha = 1;
  shadowColor = '';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  lineWidth = 1;
  readonly fills: PathFill[] = [];
  readonly texts: TextDraw[] = [];
  readonly images: ImageDraw[] = [];
  private outputScale = 1;
  private pathPoints: Array<{ x: number; y: number }> = [];
  private readonly stack: Array<Record<string, unknown>> = [];

  constructor(private readonly dpr: number) {}

  setTransform(a: number): void {
    this.outputScale = a;
  }

  beginPath(): void {
    this.pathPoints = [];
  }

  moveTo(x: number, y: number): void {
    this.pathPoints.push({ x, y });
  }

  lineTo(x: number, y: number): void {
    this.pathPoints.push({ x, y });
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.pathPoints.push({ x: cpx, y: cpy }, { x, y });
  }

  closePath(): void {}

  fill(): void {
    if (this.pathPoints.length === 0) return;
    const xs = this.pathPoints.map(({ x }) => x * this.outputScale / this.dpr);
    const ys = this.pathPoints.map(({ y }) => y * this.outputScale / this.dpr);
    this.fills.push({
      color: String(this.fillStyle),
      bounds: boundsFromEdges(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)),
    });
  }

  fillText(text: string, _x: number, y: number): void {
    const fontPx = Number(this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 10)
      * this.outputScale / this.dpr;
    this.texts.push({
      text,
      color: String(this.fillStyle),
      baseline: rounded(y * this.outputScale / this.dpr),
      fontPx: rounded(fontPx),
    });
  }

  measureText(text: string): { width: number } {
    const fontPx = Number(this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 10);
    return { width: text.length * fontPx * 0.55 };
  }

  drawImage(source: FakeCanvas | FakeImage, ...args: number[]): void {
    let x: number;
    let y: number;
    let width: number;
    let height: number;
    if (args.length === 2) {
      [x, y] = args;
      width = source instanceof FakeCanvas ? source.width : source.naturalWidth;
      height = source instanceof FakeCanvas ? source.height : source.naturalWidth;
    } else if (args.length === 4) {
      [x, y, width, height] = args;
    } else {
      [x, y, width, height] = args.slice(4);
    }
    const cssScale = this.outputScale / this.dpr;
    this.images.push({
      source,
      bounds: boundsFromEdges(
        x * cssScale,
        y * cssScale,
        (x + width) * cssScale,
        (y + height) * cssScale,
      ),
    });
  }

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      globalAlpha: this.globalAlpha,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY,
      lineWidth: this.lineWidth,
      outputScale: this.outputScale,
    });
  }

  restore(): void {
    Object.assign(this, this.stack.pop() ?? {});
  }

  clearRect(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  clip(): void {}
  translate(): void {}
  scale(): void {}
  arc(): void {}
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly style: Record<string, string> = {};
  readonly context: RecordingContext;

  constructor(dpr: number) {
    this.context = new RecordingContext(dpr);
  }

  getContext(type: string): RecordingContext | null {
    return type === '2d' ? this.context : null;
  }
}

class FakeEventSource {
  private readonly listeners = new Map<string, (event: { data: string }) => void>();

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    const listener = this.listeners.get(type);
    if (!listener) throw new Error(`Missing ${type} listener`);
    listener({ data: JSON.stringify(data) });
  }
}

function renderTvAt(
  dpr: number,
  mode: 'compact' | 'full' = 'compact',
  stateOverrides: Record<string, unknown> = {},
) {
  const source = readFileSync('src/web/public/tv/tv.js', 'utf8');
  const stage = new FakeCanvas(dpr);
  const animationFrames: Array<(time: number) => void> = [];
  let stream: FakeEventSource | undefined;
  const windowObject = {
    devicePixelRatio: dpr,
    innerWidth: mode === 'compact' ? 480 : 1200,
    innerHeight: mode === 'compact' ? 400 : 800,
    addEventListener() {},
    ClaudeRpgPotionFx: undefined,
  };
  const documentObject = {
    body: { dataset: { tvMode: mode } },
    getElementById: (id: string) => id === 'stage' ? stage : null,
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`Unexpected element ${tag}`);
      return new FakeCanvas(dpr);
    },
  };

  vm.runInNewContext(source, {
    document: documentObject,
    window: windowObject,
    Image: FakeImage,
    EventSource: class extends FakeEventSource {
      constructor(_url: string) {
        super();
        stream = this;
      }
    },
    requestAnimationFrame: (callback: (time: number) => void) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    performance: { now: () => 0 },
    location: { reload() {} },
    console,
  }, { filename: 'src/web/public/tv/tv.js' });

  if (!stream) throw new Error('Renderer did not open its EventSource');
  const cells = Array.from({ length: 15 }, () =>
    Array.from({ length: 20 }, () => ({ col: 0, row: 0, shadow: false })));
  stream.emit('layout', {
    width: 20,
    height: 15,
    cells,
    decor: [],
    monster: { x: 9, y: 6 },
  });
  stream.emit('state', {
    paused: false,
    defeat: null,
    monsterAttack: null,
    raidNumber: 12,
    fightIndex: 2,
    fightCount: 4,
    activeRaiders: 7,
    encounter: {
      id: 1,
      name: 'Elder Demon',
      hp: 50,
      maxHp: 100,
      footprint: 2,
      creatureUrl: '/sprites/creature.png',
      flying: false,
      size: 'L',
      kind: 'boss',
      packCount: 1,
    },
    players: [],
    ...stateOverrides,
  });
  const render = animationFrames.shift();
  if (!render) throw new Error('Renderer did not request an animation frame');
  render(0);

  const titleDraws = stage.context.texts.filter(({ text }) => text === 'Elder Demon');
  const titleTop = Math.min(...titleDraws.map(({ baseline, fontPx }) => baseline - fontPx * 0.82));
  const titleBottom = Math.max(...titleDraws.map(({ baseline, fontPx }) => baseline + fontPx * 0.22));
  const dungeonDraw = stage.context.images.find(({ source: image }) => image instanceof FakeCanvas);
  if (!dungeonDraw) throw new Error('Renderer did not draw the dungeon canvas');
  const barFills = stage.context.fills.filter(({ color }) =>
    color === '#180a0a' || color === '#3a0d0d' || color === '#d23b3b');
  if (mode === 'compact' && barFills.length !== 3) {
    throw new Error(`Expected 3 HP fills, got ${barFills.length}`);
  }

  return {
    backingSize: { width: stage.width, height: stage.height },
    cssSize: { width: stage.style.width, height: stage.style.height },
    dungeon: dungeonDraw.bounds,
    title: {
      top: rounded(titleTop),
      bottom: rounded(titleBottom),
      draws: titleDraws,
    },
    bar: barFills,
    texts: stage.context.texts,
  };
}

function compactRenderAt(dpr: number) {
  return renderTvAt(dpr, 'compact');
}

describe('compact TV renderer geometry', () => {
  it('shows Raid and Fight status on the full TV without changing the compact hub', () => {
    const rendering = renderTvAt(1, 'full');

    expect(rendering.texts.map(({ text }) => text)).toContain(
      'Raid 12 · Fight 2/4 · 7 Raiders active',
    );
  });

  it('labels full-TV standings, rest, and defeat values with Raiders and Raid Power', () => {
    const rendering = renderTvAt(1, 'full', {
      paused: true,
      encounter: null,
      players: [{
        id: 1,
        name: 'Astra',
        avatarUrl: '/sprites/raider.png',
        level: 4,
        effectiveTokens: 1_234,
        gold: 99,
        modifier: 1.2,
        disabled: false,
        damage: 700,
        x: null,
        y: null,
      }],
      defeat: {
        creatureUrl: '/sprites/monster.png',
        creatureIndex: 1,
        totalDamage: 700,
        mvpPlayerId: 1,
        participants: [{
          playerId: 1,
          name: 'Astra',
          damage: 700,
          tokensDuringFight: 456,
          gold: 12,
          leveledTo: null,
        }],
      },
    });
    const text = rendering.texts.map((draw) => draw.text).join('\n');

    expect(text).toContain('L4  1.2K Raid Power  99g  ×1.2');
    expect(text).toContain('awaiting Raiders');
    expect(text).toContain('456 Raid Power');
    expect(text).not.toMatch(/\btok\b|adventurer/i);
  });

  it('scales the full-TV Raid status with the encounter chrome at DPR 1 and 2', () => {
    const dpr1 = renderTvAt(1, 'full');
    const dpr2 = renderTvAt(2, 'full');
    const status = 'Raid 12 · Fight 2/4 · 7 Raiders active';
    const findText = (rendering: ReturnType<typeof renderTvAt>, text: string) => {
      const draw = rendering.texts.find((candidate) => candidate.text === text);
      if (!draw) throw new Error(`Missing ${text}`);
      return draw;
    };

    const statusAt1 = findText(dpr1, status);
    const statusAt2 = findText(dpr2, status);
    const titleAt1 = findText(dpr1, 'Elder Demon');
    const titleAt2 = findText(dpr2, 'Elder Demon');

    expect(statusAt1.fontPx / titleAt1.fontPx).toBeGreaterThanOrEqual(0.75);
    expect(statusAt2.fontPx / titleAt2.fontPx).toBeGreaterThanOrEqual(0.75);
  });

  it('keeps the compact hub geometry unchanged when Raid display state arrives', () => {
    const rendering = compactRenderAt(1);

    expect(rendering.backingSize).toEqual({ width: 480, height: 400 });
    expect(rendering.dungeon).toEqual({
      left: 0,
      top: 40,
      right: 480,
      bottom: 400,
      width: 480,
      height: 360,
    });
  });

  it('keeps the title and rounded HP bar inside the 40px status area at DPR 1', () => {
    const rendering = compactRenderAt(1);

    expect(rendering.title.top).toBeGreaterThanOrEqual(0);
    expect(rendering.title.bottom).toBeLessThanOrEqual(40);
    for (const fill of rendering.bar) {
      expect(fill.bounds.top).toBeGreaterThanOrEqual(0);
      expect(fill.bounds.bottom).toBeLessThanOrEqual(40);
    }
  });

  it('uses DPR only for output scaling of one complete 480 by 400 composition', () => {
    const dpr1 = compactRenderAt(1);
    const dpr2 = compactRenderAt(2);

    expect(dpr1.backingSize).toEqual({ width: 480, height: 400 });
    expect(dpr2.backingSize).toEqual({ width: 960, height: 800 });
    expect(dpr1.cssSize).toEqual({ width: '480px', height: '400px' });
    expect(dpr2.cssSize).toEqual(dpr1.cssSize);
    expect(dpr1.dungeon).toEqual({
      left: 0,
      top: 40,
      right: 480,
      bottom: 400,
      width: 480,
      height: 360,
    });
    expect(dpr2.dungeon).toEqual(dpr1.dungeon);
    expect(dpr2.title).toEqual(dpr1.title);
    expect(dpr2.bar).toEqual(dpr1.bar);
  });
});
