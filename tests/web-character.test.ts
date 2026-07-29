import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { seedSettings, setSetting } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  app = createApp({ db, config: loadConfig({}) });
});

describe('character sheet', () => {
  it('GET /character shows the login form', async () => {
    const res = await request(app).get('/character');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="token"');
  });

  it('GET /character?token=... shows the sheet with stats and snippet', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 1001);
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toContain('Gandalf');
    expect(res.text).toContain('claude_rpg_token=');
    expect(res.text).toContain('class="character-avatar sprite-anim"');
    expect(res.text.match(/class="px frame-a"/g)).toHaveLength(1);
    expect(res.text.match(/class="px frame-b"/g)).toHaveLength(1);
    expect(res.text.match(/<canvas id="dye-preview"/g)).toHaveLength(1);
    expect(res.text).toContain('role="tablist" aria-label="Character sections"');
    expect(res.text).toContain('id="hub-tab-live" role="tab" aria-selected="true"');
    expect(res.text).toContain('id="hub-live" role="tabpanel"');
    expect(res.text).toContain('<iframe class="hub-dungeon-frame" src="/tv/embed"');
    expect(res.text).toContain('id="hub-inventory" role="tabpanel" hidden');
    expect(res.text).toContain('id="hub-wardrobe" role="tabpanel" hidden');
    expect(res.text).toContain('/static/player-hub.css');
    expect(res.text).toContain('/static/player-hub.js');
    expect(res.text).toContain('window.__PLAYER_HUB__ =');
    expect(res.text).toContain('class="hub-character-settings"');
    expect(res.text).toContain('id="hub-effects"');
    expect(res.text).toContain('aria-controls="hub-effects"');
    expect(res.text).toContain('id="hub-effects-list"');
    expect(res.text).toContain('id="hub-effects-close"');
    expect(res.text.match(/id="hub-item-detail"/g)).toHaveLength(1);
    expect(res.text).toContain('<dialog id="potion-confirm"');
    expect(res.text).toContain('id="potion-confirm-drink"');
    expect(res.text).toContain('id="potion-confirm-keep"');
    expect(res.text).toContain('id="hub-potion-feedback"');
    expect(res.text).toContain('data-hub-gold');
    expect(res.text.match(/<span>Store<\/span>/g)).toHaveLength(1);
    const hubBootstrap = res.text.match(/window\.__PLAYER_HUB__ = (\{.*?\});<\/script>/s);
    expect(hubBootstrap).not.toBeNull();
    expect(hubBootstrap![1]).not.toContain('<');
    const hubClient = JSON.parse(hubBootstrap![1]) as {
      token: string;
      initialState: Record<string, unknown>;
      endpoints: { state: string };
    };
    expect(hubClient.token).toBe(p.auth_token);
    expect(hubClient.endpoints.state).toContain(encodeURIComponent(p.auth_token));
    expect(JSON.stringify(hubClient.initialState)).not.toContain(p.auth_token);
    expect(JSON.stringify(hubClient.initialState)).not.toContain('auth_token');
    expect(res.text).not.toContain('dye-active-label');
    const steel = res.text.indexOf('data-recipe="steel"');
    const bronze = res.text.indexOf('data-recipe="bronze"');
    const gold = res.text.indexOf('data-recipe="gold"');
    const restore = res.text.indexOf('data-recipe="none"');
    expect([steel, bronze, gold, restore]).toEqual([...([steel, bronze, gold, restore])].sort((a, b) => a - b));
    expect(res.text.match(/class="dye-fin" data-recipe=/g)).toHaveLength(4);
    expect(res.text).not.toContain('class="dye-fin dye-default"');
    expect(res.text).not.toContain('↺');
    expect(res.text).toContain('class="dye-fin-swatch dye-fin-default" aria-hidden="true"');
  });

  it('renders owned potion quantity as unavailable when current tuning is invalid', async () => {
    const player = createPlayer(
      db,
      { name: 'Shelf Keeper', class_key: 'wizard', gender: 'F' },
      1_000,
    );
    applyGoldMutation(db, {
      playerId: player.id,
      amount: 500_000,
      reason: 'opening_balance',
      sourceTable: 'test',
      sourceId: 'shelf-keeper-opening',
      now: 1_001,
    });
    expect(purchaseConsumable(db, {
      playerId: player.id,
      skuId: 'potion_gold_t1',
      quantity: 1,
      expectedUnitPrice: 100_000,
      requestId: 'shelf-keeper-purchase',
      now: 1_002,
      timeZone: 'America/New_York',
    })).toMatchObject({ ok: true, inventory: 1 });
    setSetting(db, 'potion_damage_t1_base_hit_pct', 'not-a-number');

    const response = await request(app).get('/character').query({
      token: player.auth_token,
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('Beginner Gold Potion');
    expect(response.text).toContain('×1');
    expect(response.text).toContain('Potion tuning is temporarily unavailable.');
    expect(response.text).toContain('Unavailable until tuning is repaired');
    expect(response.text).toMatch(/id="hub-potion-drink"[^>]*disabled/);
    const hubBootstrap = response.text.match(
      /window\.__PLAYER_HUB__ = (\{.*?\});<\/script>/s,
    );
    expect(hubBootstrap).not.toBeNull();
    const hubClient = JSON.parse(hubBootstrap![1]) as {
      initialState: { inventory: Array<Record<string, unknown>> };
    };
    expect(hubClient.initialState.inventory).toEqual([
      expect.objectContaining({
        sku: 'potion_gold_t1',
        quantity: 1,
        available: false,
      }),
    ]);
  });

  it('rejects an unknown token', async () => {
    const res = await request(app).get('/character').query({ token: 'nope' });
    expect(res.status).toBe(404);
  });

  it('escapes adversarial authenticated and public leader names in the player-hub bootstrap', async () => {
    const playerName = 'Hero</script><script id="player-injected">';
    const leaderName = 'Leader<script id="leader-injected">';
    const player = createPlayer(db, { name: playerName, class_key: 'wizard', gender: 'M' }, 1000);
    const leader = createPlayer(db, { name: leaderName, class_key: 'thief', gender: 'F' }, 1001);
    const dungeon = db.prepare(
      `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
       VALUES (1, 'Ossuary Pale', 11, 2, 1000)`,
    ).run();
    const encounter = db.prepare(
      `INSERT INTO encounters
        (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
         pack_count, max_hp, current_hp, status, started_at)
       VALUES (?, 0, 'single', 1, 1, 1, 5000, 3000, 'active', 1000)`,
    ).run(Number(dungeon.lastInsertRowid));
    const encounterId = Number(encounter.lastInsertRowid);
    db.prepare(
      'UPDATE game_state SET current_dungeon_id=?, current_encounter_id=? WHERE id=1',
    ).run(Number(dungeon.lastInsertRowid), encounterId);
    db.prepare(
      `INSERT INTO encounter_damage
        (encounter_id, player_id, damage_total, hits, max_hit) VALUES (?, ?, ?, 1, ?)`,
    ).run(encounterId, leader.id, 900, 900);
    db.prepare(
      `INSERT INTO encounter_damage
        (encounter_id, player_id, damage_total, hits, max_hit) VALUES (?, ?, ?, 1, ?)`,
    ).run(encounterId, player.id, 500, 500);

    const res = await request(app).get('/character').query({ token: player.auth_token });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script id="player-injected">');
    expect(res.text).not.toContain('<script id="leader-injected">');
    expect(res.text).not.toContain(playerName);
    expect(res.text).not.toContain(leaderName);
    expect(res.text).toContain('\\u003c/script>');
    expect(res.text).toContain('Leader\\u003cscript');
    const hubBootstrap = res.text.match(/window\.__PLAYER_HUB__ = (\{.*?\});<\/script>/s);
    expect(hubBootstrap).not.toBeNull();
    const hubClient = JSON.parse(hubBootstrap![1]) as {
      initialState: { currentFight: { leaders: { name: string }[] } };
    };
    expect(hubClient.initialState.currentFight.leaders.map(({ name }) => name)).toEqual([
      leaderName, playerName,
    ]);
    expect(JSON.stringify(hubClient.initialState)).not.toContain(player.auth_token);
    expect(JSON.stringify(hubClient.initialState)).not.toContain('auth_token');
  });

  it('renames via POST /character/rename', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app)
      .post('/character/rename')
      .type('form')
      .send({ token: p.auth_token, name: 'Gandalf the White' });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)?.name).toBe('Gandalf the White');
  });

  it('deletes via POST /character/delete', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app)
      .post('/character/delete')
      .type('form')
      .send({ token: p.auth_token });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });

  it('returns 500 (not a crash) when a player has a corrupt class_key', async () => {
    const p = createPlayer(db, { name: 'Brokie', class_key: 'knight', gender: 'M' }, 1000);
    // Corrupt the class_key directly so classSpriteUrl() will throw inside the async handler.
    db.prepare('UPDATE players SET class_key = ? WHERE id = ?').run('not_a_class', p.id);
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(500);
  });
});
