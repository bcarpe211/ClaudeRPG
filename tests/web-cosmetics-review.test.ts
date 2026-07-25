import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import request from 'supertest';
import { PNG } from 'pngjs';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { creatureSpriteFile, type Gender } from '../src/domain/classes';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { LEGEND, PICKER_ORDER, SLOT_LABELS, slotmapFile, SLOTS } from '../src/domain/slots';
import { createApp } from '../src/web/app';

let fixtureDir: string;
let spritesDir: string;
let slotmapsDir: string;
let dbs: Database.Database[];

function sourcePng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  png.data.set([
    42, 52, 62, 255,
    92, 102, 112, 255,
    142, 152, 162, 255,
    192, 202, 212, 255,
  ]);
  return PNG.sync.write(png);
}

function slotmapPng(slot: number): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  const color = LEGEND.find(([candidate]) => candidate === slot)?.[1] ?? [0, 0, 0];
  for (let pixel = 0; pixel < 4; pixel++) {
    const offset = pixel * 4;
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = slot === SLOTS.outline ? 0 : 255;
  }
  return PNG.sync.write(png);
}

function writeSource(
  classKey: string,
  gender: Gender,
  frame: 'a' | 'b',
): void {
  const index = spriteFileIndex(classKey, gender, frame);
  writeFileSync(
    join(spritesDir, 'creatures_24x24', creatureSpriteFile(index)),
    sourcePng(),
  );
}

function writeMap(sprite: string, frame: 'a' | 'b', slot: number): void {
  writeFileSync(slotmapFile(sprite, frame, slotmapsDir), slotmapPng(slot));
}

function app(enabled = true) {
  const db = openDb(':memory:');
  dbs.push(db);
  return createApp({
    db,
    config: loadConfig({
      ENABLE_COSMETICS_REVIEW: enabled ? '1' : '0',
      SPRITES_DIR: spritesDir,
    }),
    slotmapsDir,
  });
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'claude-rpg-cosmetics-review-'));
  spritesDir = join(fixtureDir, 'sprites');
  slotmapsDir = join(fixtureDir, 'slotmaps');
  mkdirSync(join(spritesDir, 'creatures_24x24'), { recursive: true });
  mkdirSync(slotmapsDir);
  dbs = [];

  for (const frame of ['a', 'b'] as const) {
    writeSource('wizard', 'M', frame);
    writeMap('wizard_M', frame, SLOTS.body);
    writeMap('knight_M', frame, SLOTS.body);
    writeSource('thief', 'M', frame);
  }
});

afterEach(() => {
  for (const db of dbs) db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('cosmetics review route gating', () => {
  it('does not register the page when disabled', async () => {
    expect((await request(app(false)).get('/cosmetics-review')).status).toBe(404);
  });

  it('does not register either endpoint when disabled', async () => {
    const disabled = app(false);
    expect((await request(disabled).get('/cosmetics-review')).status).toBe(404);
    expect((
      await request(disabled)
        .get('/cosmetics-review/render/wizard_M/a.png?mode=original')
    ).status).toBe(404);
  });
});

describe('cosmetics review page', () => {
  it('renders all 18 variants and both frame URLs for each', async () => {
    const res = await request(app()).get('/cosmetics-review');

    expect(res.status).toBe(200);
    for (const classKey of [
      'knight', 'thief', 'ranger', 'wizard', 'priest', 'shaman',
      'berserker', 'swordsman', 'paladin',
    ]) {
      expect(res.text).toContain(`${classKey}_M`);
      expect(res.text).toContain(`${classKey}_F`);
    }
    expect(
      res.text.match(
        /\/cosmetics-review\/render\/[a-z]+_[MF]\/[ab]\.png\?mode=original/g,
      ),
    ).toHaveLength(36);
  });

  it('renders paired class trays, synchronized specimens, and inventory status', async () => {
    const res = await request(app()).get('/cosmetics-review');
    const cards = res.text.match(
      /<article class="review-variant"[\s\S]*?<\/article>/g,
    ) ?? [];
    const rows = res.text.match(
      /<section class="review-class-row"[\s\S]*?<\/section>/g,
    ) ?? [];

    expect(cards).toHaveLength(18);
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row).toContain('data-gender="M"');
      expect(row).toContain('data-gender="F"');
      expect(row.indexOf('data-gender="M"'))
        .toBeLessThan(row.indexOf('data-gender="F"'));
    }
    for (const card of cards) {
      expect(card.match(/class="sprite-anim"/g)).toHaveLength(1);
      expect(card.match(/class="frame-a"/g)).toHaveLength(1);
      expect(card.match(/class="frame-b"/g)).toHaveLength(1);
      expect(card.match(/class="review-status/g)).toHaveLength(1);
    }
  });

  it('renders the complete global dye bench and serialized initial state', async () => {
    const res = await request(app()).get('/cosmetics-review');

    for (const mode of [
      'original', 'slots', 'focus', 'hue', 'black', 'white', 'steel',
    ]) {
      expect(res.text).toContain(`data-review-mode="${mode}"`);
    }
    expect(res.text.match(/id="review-slot"/g)).toHaveLength(1);
    const select = res.text.match(
      /<select id="review-slot"[\s\S]*?<\/select>/,
    )?.[0] ?? '';
    expect(select.match(/<option /g)).toHaveLength(11);
    for (const slot of PICKER_ORDER) {
      expect(select).toContain(`value="${slot}"`);
      expect(select).toContain(SLOT_LABELS[slot]);
    }
    expect(res.text).toMatch(/id="review-hue"[^>]*min="0"[^>]*max="359"/);
    expect(res.text).toContain('id="review-motion"');
    expect(res.text).toContain('/static/anim.js');
    expect(res.text).toContain('/static/cosmetics-review.js');
    expect(res.text).toContain('window.__COSMETICS_REVIEW__');
    expect(res.text).toContain('"initialMode":"original"');
    expect(res.text).toContain('"initialSlot":1');
    expect(res.text).toContain('"initialHue":210');
  });

  it('uses the injected slot-map directory for page inventory and render output', async () => {
    const reviewApp = app();
    const page = await request(reviewApp).get('/cosmetics-review');
    const wizardCard = page.text.match(
      /<article class="review-variant"\s+data-sprite="wizard_M"[\s\S]*?<\/article>/,
    )?.[0] ?? '';
    const rendered = await request(reviewApp)
      .get('/cosmetics-review/render/wizard_M/a.png?mode=slots');

    expect(page.status).toBe(200);
    expect(wizardCard.match(/class="review-channel"/g)).toHaveLength(1);
    expect(wizardCard).toContain('Missing expected A channel: Belt');
    expect(wizardCard).toContain('Missing expected B channel: Weapon');
    expect(wizardCard).not.toContain('Map inventory matches');
    expect(rendered.status).toBe(200);
    expect(Array.from(PNG.sync.read(rendered.body as Buffer).data.slice(0, 3)))
      .toEqual([255, 0, 0]);
  });
});

describe('cosmetics review renderer', () => {
  it('returns an uncached PNG for the original frame', async () => {
    const res = await request(app())
      .get('/cosmetics-review/render/wizard_M/a.png?mode=original');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(() => PNG.sync.read(res.body as Buffer)).not.toThrow();
  });

  it.each([
    ['slots', ''],
    ['focus', '&slot=1'],
    ['hue', '&slot=1&hue=210'],
    ['black', '&slot=1'],
    ['white', '&slot=1'],
    ['steel', '&slot=1'],
  ])('renders %s mode', async (mode, query) => {
    const res = await request(app())
      .get(`/cosmetics-review/render/wizard_M/a.png?mode=${mode}${query}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
  });

  it.each([
    ['/cosmetics-review/render/not-a-sprite/a.png?mode=original', 404],
    ['/cosmetics-review/render/wizard_X/a.png?mode=original', 404],
    ['/cosmetics-review/render/unknown_M/a.png?mode=original', 404],
    ['/cosmetics-review/render/wizard_M/c.png?mode=original', 404],
    ['/cosmetics-review/render/wizard_M/a.jpg?mode=original', 404],
    ['/cosmetics-review/render/knight_M/a.png?mode=original', 404],
    ['/cosmetics-review/render/thief_M/a.png?mode=original', 404],
    ['/cosmetics-review/render/wizard_M/a.png?mode=invalid', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=focus', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=hue&slot=1', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=black', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=white', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=steel', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=focus&slot=0', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=focus&slot=-1', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=focus&slot=12', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=focus&slot=1.5', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=hue&slot=1&hue=-1', 400],
    ['/cosmetics-review/render/wizard_M/a.png?mode=hue&slot=1&hue=360', 400],
  ] as const)('returns %s for %s', async (url, status) => {
    expect((await request(app()).get(url)).status).toBe(status);
  });

  it.each([
    '/cosmetics-review/render/wizard_M/a.png?mode=hue&slot=1&hue=',
    '/cosmetics-review/render/wizard_M/a.png?mode=hue&slot=1&hue=%20%20',
    '/cosmetics-review/render/wizard_M/a.png?mode=original&slot=',
    '/cosmetics-review/render/wizard_M/a.png?mode=original&slot=%20%20',
    '/cosmetics-review/render/wizard_M/a.png?mode=original&hue=',
    '/cosmetics-review/render/wizard_M/a.png?mode=original&hue=%20%20',
  ])('rejects an empty or whitespace numeric query value: %s', async (url) => {
    expect((await request(app()).get(url)).status).toBe(400);
  });

  it('reads changed slot-map bytes on every render request', async () => {
    const reviewApp = app();
    const first = await request(reviewApp)
      .get('/cosmetics-review/render/wizard_M/a.png?mode=slots');
    writeMap('wizard_M', 'a', SLOTS.weapon);
    const second = await request(reviewApp)
      .get('/cosmetics-review/render/wizard_M/a.png?mode=slots');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(Array.from(PNG.sync.read(first.body as Buffer).data.slice(0, 3)))
      .toEqual(LEGEND.find(([slot]) => slot === SLOTS.body)?.[1]);
    expect(Array.from(PNG.sync.read(second.body as Buffer).data.slice(0, 3)))
      .toEqual(LEGEND.find(([slot]) => slot === SLOTS.weapon)?.[1]);
    expect(second.body).not.toEqual(first.body);
  });
});
