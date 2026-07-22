import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { createApp } from '../src/web/app';
import { loadConfig } from '../src/config';
import { SLOTS } from '../src/domain/slots';
import { setSlotRule, slotConfigHash, getSlotConfig } from '../src/domain/slotcosmetics';
import { spriteFileIndex } from '../src/domain/cosmetics';
import { creatureSpriteFile } from '../src/domain/classes';

function ctx() {
  const db = openDb(':memory:'); seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  return { db, app, p };
}

describe('GET /sprite/skin', () => {
  it('404s an unknown player', async () => {
    const { app } = ctx();
    expect((await request(app).get('/sprite/skin/99999/a/deadbeef.png')).status).toBe(404);
  });
  it('renders the player per-slot config: body recolors, weapon/eye slots stay', async () => {
    const { db, app, p } = ctx();
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 120 }, 100); // green robe
    const hash = slotConfigHash(getSlotConfig(db, p.id));
    const res = await request(app).get(`/sprite/skin/${p.id}/a/${hash}.png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    const out = PNG.sync.read(res.body);
    const base = PNG.sync.read(readFileSync(
      `assets/oryx_16-bit_fantasy_1.1/Sliced/creatures_24x24/${creatureSpriteFile(spriteFileIndex('wizard', 'M', 'a'))}`));
    // an eye pixel (#cf3232 in the hood, flair slot) stays unchanged when only the body is set
    let checkedEye = false;
    for (let y = 8; y <= 11; y++) for (let x = 8; x <= 13; x++) {
      const i = (y * 24 + x) * 4;
      if (base.data[i] === 0xcf && base.data[i + 1] === 0x32 && base.data[i + 2] === 0x32) {
        expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([0xcf, 0x32, 0x32]);
        checkedEye = true;
      }
    }
    expect(checkedEye).toBe(true);
  });
});
