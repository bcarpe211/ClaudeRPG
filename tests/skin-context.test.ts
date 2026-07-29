import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { buildLeaderboards } from '../src/domain/leaderboards';
import { createPlayer } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { buildShopViewModel } from '../src/domain/shopview';
import {
  getEntitledSlotConfig,
  resetSkinAssetFingerprintCache,
  setSlotRule,
  skinRenderHash,
} from '../src/domain/slotcosmetics';
import { seedSettings } from '../src/domain/settings';
import { SLOTS } from '../src/domain/slots';
import { creatureSpriteFile } from '../src/domain/classes';
import { spriteFileIndex, spriteId } from '../src/domain/cosmetics';
import { TvHub } from '../src/web/tvhub';
import { buildTvState } from '../src/web/tvview';
import { createApp } from '../src/web/app';

const leaderboardCfg = {
  decayAfterMinutes: 5,
  decaySpanMinutes: 5,
  tokenModifierK: 20_000,
  modifierCap: 200,
};

let fixtureDir: string;
let spritesDir: string;
let slotmapsDir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'clauderpg-skin-contexts-'));
  spritesDir = join(fixtureDir, 'sprites');
  slotmapsDir = join(fixtureDir, 'slotmaps');
  mkdirSync(join(spritesDir, 'creatures_24x24'), { recursive: true });
  mkdirSync(slotmapsDir);
  for (const frame of ['a', 'b'] as const) {
    writeFileSync(join(
      spritesDir,
      'creatures_24x24',
      creatureSpriteFile(spriteFileIndex('wizard', 'M', frame)),
    ), `configured-${frame}`);
  }
  db = openDb(':memory:');
  seedSettings(db);
  resetSkinAssetFingerprintCache();
});

afterEach(() => {
  resetSkinAssetFingerprintCache();
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
});

function customizedPlayer() {
  const player = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
  db.prepare('UPDATE players SET gold = 2000000, effective_tokens = 10 WHERE id = ?').run(player.id);
  purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 2);
  setSlotRule(db, player.id, SLOTS.body, { op: 'hue', hue: 120 }, 3);
  return player;
}

describe('configured skin asset context', () => {
  it('drives shop, TV state, leaderboards, and TvHub URLs from the same roots', () => {
    const player = customizedPlayer();
    const assets = { spritesDir, slotmapsDir };
    const hash = skinRenderHash(
      spriteId(player.class_key, player.gender),
      getEntitledSlotConfig(db, player),
      slotmapsDir,
      spritesDir,
    );
    const expectedUrl = `/sprite/skin/${player.id}/a/${hash}.png`;

    expect(buildShopViewModel(
      db,
      player.id,
      slotmapsDir,
      spritesDir,
      1_000,
      'America/New_York',
    )?.avatarA).toBe(expectedUrl);
    expect(buildTvState(db, 1_000, assets).players[0].avatarUrl).toBe(expectedUrl);
    for (const board of buildLeaderboards(db, 1_000, leaderboardCfg, { assets })) {
      expect(board.entries[0].avatarUrl).toBe(expectedUrl);
    }

    const frames: string[] = [];
    const hub = new TvHub(db, assets);
    hub.addClient({ write: (chunk) => frames.push(chunk) }, 1_000);
    const skinFrames = frames.filter(
      (frame) => frame.startsWith('event: state') || frame.startsWith('event: leaderboards'),
    );
    expect(skinFrames).toHaveLength(2);
    expect(skinFrames.every((frame) => frame.includes(expectedUrl))).toBe(true);
  });

  it('drives character, canonical redirect, and registration landing URLs through createApp', async () => {
    const player = customizedPlayer();
    const hash = skinRenderHash(
      spriteId(player.class_key, player.gender),
      getEntitledSlotConfig(db, player),
      slotmapsDir,
      spritesDir,
    );
    const expectedUrl = `/sprite/skin/${player.id}/a/${hash}.png`;
    const dungeon = db.prepare(
      'INSERT INTO dungeons (level, theme, seed, regular_count, created_at) VALUES (1, ?, 1, 1, 1)',
    ).run('Cave');
    const encounter = db.prepare(
      `INSERT INTO encounters
       (dungeon_id, index_in_dungeon, kind, creature_index, footprint, pack_count,
        max_hp, current_hp, status, started_at)
       VALUES (?, 0, 'single', 1, 1, 1, 100, 100, 'active', 1)`,
    ).run(Number(dungeon.lastInsertRowid));
    db.prepare(
      'UPDATE game_state SET current_dungeon_id = ?, current_encounter_id = ?, paused = 0 WHERE id = 1',
    ).run(Number(dungeon.lastInsertRowid), Number(encounter.lastInsertRowid));
    const app = createApp({
      db,
      config: loadConfig({ SPRITES_DIR: spritesDir, DB_PATH: join(fixtureDir, 'app.db') }),
      slotmapsDir,
    });

    const character = await request(app).get('/character').query({ token: player.auth_token });
    expect(character.status).toBe(200);
    expect(character.text).toContain(`src="${expectedUrl}"`);

    const redirect = await request(app).get(`/sprite/skin/${player.id}/a/stale.png`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(expectedUrl);

    const landing = await request(app).get('/');
    expect(landing.status).toBe(200);
    expect(landing.text).toContain(`src="${expectedUrl}"`);
  });
});
