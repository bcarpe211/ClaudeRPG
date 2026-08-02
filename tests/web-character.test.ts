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

  it('GET /character?token=... shows the Raider Hub without a persistent setup snippet', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 1001);
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toContain('Gandalf');
    expect(res.text).toContain('Raider Hub');
    expect(res.text).toContain('Current Raid');
    expect(res.text).toContain('Raid time');
    expect(res.text).toContain('Companion Setup');
    expect(res.text).toContain('Raider settings');
    expect(res.text).toContain('Generate one-time command');
    expect(res.text).not.toContain('claude_rpg_token=');
    expect(res.text).not.toContain('Total tokens');
    expect(res.text).toContain('class="character-avatar sprite-anim"');
    expect(res.text.match(/class="px frame-a"/g)).toHaveLength(1);
    expect(res.text.match(/class="px frame-b"/g)).toHaveLength(1);
    expect(res.text.match(/<canvas id="dye-preview"/g)).toHaveLength(1);
    expect(res.text).toContain('role="tablist" aria-label="Raider sections"');
    expect(res.text).toContain('id="hub-tab-live" role="tab" aria-selected="true"');
    expect(res.text).toContain('id="hub-live" role="tabpanel"');
    expect(res.text).toContain('<iframe class="hub-dungeon-frame" src="/tv/embed"');
    expect(res.text.match(/class="hub-dungeon"/g)).toHaveLength(1);
    expect(res.text.match(/class="hub-subpanel hub-fight-leaders"/g)).toHaveLength(1);
    expect(res.text).toContain('id="hub-leaders" tabindex="0" aria-labelledby="hub-leaders-title"');
    expect(res.text.match(/class="hub-today-panel"/g)).toHaveLength(1);
    const dungeonIndex = res.text.indexOf('class="hub-dungeon"');
    const leadersIndex = res.text.indexOf('class="hub-subpanel hub-fight-leaders"');
    const todayIndex = res.text.indexOf('class="hub-today-panel"');
    expect(dungeonIndex).toBeLessThan(leadersIndex);
    expect(leadersIndex).toBeLessThan(todayIndex);
    expect(res.text).not.toContain('class="hub-live-side"');
    expect(res.text).toContain('<span>Raid time</span>');
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
      endpoints: { state: string; enroll: string };
    };
    expect(hubClient.token).toBe(p.auth_token);
    expect(hubClient.endpoints.state).toContain(encodeURIComponent(p.auth_token));
    expect(hubClient.endpoints.enroll).toBe('/api/raiders/enrollments');
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

  it('renders compact informational Run Details after the current Raid support cards', async () => {
    const player = createPlayer(
      db,
      { name: 'Parallel Raider', class_key: 'ranger', gender: 'F' },
      Date.now() - 20_000,
    );
    const observedAt = Date.now() - 100;
    db.prepare(
      'INSERT INTO raider_identities (player_id, dedupe_secret, created_at) VALUES (?, ?, ?)',
    ).run(player.id, 'c'.repeat(64), observedAt - 20_000);
    const insert = db.prepare(
      `INSERT INTO runs
        (player_id, provider, surface, run_key, state, started_at_ms,
         terminal_at_ms, last_event_at_ms, last_observed_at_ms, usage_input,
         usage_output, usage_cache_read, usage_cache_write,
         usage_reasoning_output, latest_model, latest_effort, policy_version,
         raid_power, created_at, updated_at)
       VALUES (?, 'codex', ?, ?, 'open', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         'raid-power-v1', ?, ?, ?)` ,
    );
    insert.run(
      player.id, 'codex_cli', 'a'.repeat(64), observedAt - 9_000,
      observedAt - 1_000, observedAt - 1_000, 1, 2, 3, 4, 5,
      'gpt-literal', 'xhigh', 123, observedAt - 9_000, observedAt - 1_000,
    );
    insert.run(
      player.id, 'codex_desktop', 'b'.repeat(64), observedAt - 5_000,
      observedAt, observedAt, 11, 22, 33, 44, 55,
      null, null, 321, observedAt - 5_000, observedAt,
    );

    const response = await request(app).get('/character').query({ token: player.auth_token });

    expect(response.status).toBe(200);
    expect(response.text).toContain('2 Runs active');
    expect(response.text).toContain('Run Details');
    expect(response.text).toContain('Latest Run');
    expect(response.text).toContain('codex');
    expect(response.text).toContain('codex_desktop');
    expect(response.text).toContain('Unknown');
    expect(response.text).toContain('Open');
    expect(response.text).toContain('11 input');
    expect(response.text).toContain('22 output');
    expect(response.text).toContain('321 Raid Power');
    const todayIndex = response.text.indexOf('class="hub-today-panel"');
    const runDetailsIndex = response.text.indexOf('class="hub-run-details"');
    expect(todayIndex).toBeLessThan(runDetailsIndex);
    expect(response.text).not.toContain('a'.repeat(64));
    expect(response.text).not.toContain('b'.repeat(64));
    expect(response.text).not.toContain('device_id');
    expect(response.text).not.toContain('run_key');
    expect(response.text).not.toMatch(/model[^<]*(rank|rarity|multiplier)/i);
    expect(response.text).not.toMatch(/effort[^<]*(rank|rarity|multiplier)/i);
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
    expect(response.text).toContain('class="hub-inventory-room"');
    expect(response.text).toContain('class="hub-room-tiles" aria-hidden="true"');
    expect(response.text.match(/class="hub-room-tile"/g)).toHaveLength(54);
    expect(response.text.match(/class="hub-inventory-cell"/g)).toHaveLength(28);
    expect(response.text).not.toContain('hub-room-crack-a');
    expect(response.text).not.toContain('hub-room-crack-b');
    expect(response.text).not.toContain('hub-room-moss');
    expect(response.text).not.toContain('hub-room-door');
    expect(response.text).toContain('aria-label="Beginner Gold Potion, 1 owned"');
    expect(response.text).toContain('<span class="hub-item-qty" aria-hidden="true">1</span>');
    expect(response.text).not.toContain('class="hub-item-name"');
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
