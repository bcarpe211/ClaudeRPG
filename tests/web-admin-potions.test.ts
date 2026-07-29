import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { ensureAdmin } from '../src/domain/admin';
import { applyGoldMutation } from '../src/domain/goldledger';
import { purchaseConsumable } from '../src/domain/inventory';
import { activatePotion } from '../src/domain/potions';
import { createPlayer } from '../src/domain/players';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });
const timeZone = 'America/New_York';
let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  ensureAdmin(db, config.adminUsername, config.adminPassword);
  app = createApp({ db, config });
});

async function adminAgent() {
  const agent = request.agent(app);
  const login = await agent.post('/admin/login').type('form').send({
    username: 'boss',
    password: 'secret',
  });
  expect(login.status).toBe(302);
  return agent;
}

function seedReportRows() {
  const boosted = createPlayer(db, { name: 'Boosted', class_key: 'knight', gender: 'M' }, 1);
  const rival = createPlayer(db, { name: 'Rival', class_key: 'thief', gender: 'F' }, 2);
  for (const player of [boosted, rival]) {
    applyGoldMutation(db, {
      playerId: player.id,
      amount: 1_000_000,
      reason: 'opening_balance',
      sourceTable: 'test',
      sourceId: `admin-opening-${player.id}`,
      now: 100,
    });
  }
  for (const [sku, price, requestId, at] of [
    ['potion_gold_t1', 100_000, 'admin-gold', 1_000],
    ['potion_damage_t1', 150_000, 'admin-damage', 1_100],
  ] as const) {
    expect(purchaseConsumable(db, {
      playerId: boosted.id,
      skuId: sku,
      quantity: 1,
      expectedUnitPrice: price,
      requestId: `${requestId}-purchase`,
      now: at,
      timeZone,
    })).toMatchObject({ ok: true });
    expect(activatePotion(db, {
      playerId: boosted.id,
      skuId: sku,
      requestId: `${requestId}-activation`,
      now: at + 500,
      timeZone,
    })).toMatchObject({ ok: true });
  }
  const gold = db.prepare(
    "SELECT id FROM potion_activations WHERE sku='potion_gold_t1'",
  ).get() as { id: number };
  const damage = db.prepare(
    "SELECT id FROM potion_activations WHERE sku='potion_damage_t1'",
  ).get() as { id: number };
  db.prepare(
    `UPDATE potion_activations
     SET status='completed', completed_at=8000, base_gold=125000,
         stretch_gold=25000, eligible_tokens=2500000
     WHERE id=?`,
  ).run(gold.id);
  db.prepare(
    `UPDATE potion_activations
     SET status='completed', completed_at=8000, potion_bonus_damage=250
     WHERE id=?`,
  ).run(damage.id);

  const dungeon = db.prepare(
    `INSERT INTO dungeons (level, theme, seed, regular_count, created_at)
     VALUES (1, 'Ossuary Pale', 1, 2, 2000)`,
  ).run();
  const encounter = db.prepare(
    `INSERT INTO encounters
      (dungeon_id, index_in_dungeon, kind, creature_index, footprint,
       pack_count, max_hp, current_hp, status, started_at, ended_at,
       reward_model_version, reward_work_pct, reward_damage_pct,
       reward_podium_first_pct, reward_podium_second_pct, reward_podium_third_pct)
     VALUES (?, 0, 'single', 1, 1, 1, 1000, 0, 'defeated', 2000, 7000,
       'hybrid-v1', 80, 10, 5, 3, 2)`,
  ).run(Number(dungeon.lastInsertRowid));
  const encounterId = Number(encounter.lastInsertRowid);
  db.prepare(
    `INSERT INTO potion_activation_encounters (activation_id, encounter_id, bonus_damage)
     VALUES (?, ?, 250)`,
  ).run(damage.id, encounterId);
  const insertAward = db.prepare(
    `INSERT INTO encounter_reward_awards
      (encounter_id, player_id, effective_tokens, damage_total,
       potion_bonus_damage, damage_rank, work_gold, damage_gold,
       podium_gold, total_gold, model_version, awarded_at)
     VALUES (?, ?, 100, ?, ?, ?, ?, ?, ?, ?, 'hybrid-v1', 7000)`,
  );
  insertAward.run(encounterId, boosted.id, 1000, 250, 1, 400, 100, 50, 550);
  insertAward.run(encounterId, rival.id, 900, 0, 2, 400, 20, 30, 450);
  db.prepare(
    `INSERT INTO game_clock_days (office_day, active_ms)
     VALUES ('2026-07-28', 3600000)`,
  ).run();
  return { boosted };
}

describe('admin Potion Lab', () => {
  it('redirects unauthenticated requests to the admin login', async () => {
    const response = await request(app).get('/admin/potions');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/admin/login');
  });

  it('renders Gold, Damage, economy, inventory, and Tier 2 evidence without auth tokens', async () => {
    const { boosted } = seedReportRows();
    const agent = await adminAgent();

    const response = await agent.get('/admin/potions');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.text).toContain('Potion Lab');
    expect(response.text).toContain('Gold Potion outcomes');
    expect(response.text).toContain('Purchase date');
    expect(response.text).toContain('Activation / completion');
    expect(response.text).toContain('Wall span');
    expect(response.text).toContain('Combat active');
    expect(response.text).toContain('Base payout');
    expect(response.text).toContain('Stretch payout');
    expect(response.text).toContain('Break-even rate');
    expect(response.text).toContain('Stretch rate');
    expect(response.text).toContain('1970-01-01T00:00:01.000Z');
    expect(response.text).toContain('Completed ·');
    expect(response.text).toContain('0h 0m 6s');
    expect(response.text).toContain('2h 0m 0s');
    expect(response.text).toContain('2,500,000');
    expect(response.text).toContain('125,000g');
    expect(response.text).toContain('25,000g');
    expect(response.text).toContain('150,000g');
    expect(response.text).toContain('100%');
    expect(response.text).toContain('50,000g net');
    expect(response.text).toContain('Median net by player');
    expect(response.text).toContain('Median net by office hour');
    expect(response.text).toContain('Damage counterfactuals');
    expect(response.text).toContain('Activation window');
    expect(response.text).toContain('Actual damage');
    expect(response.text).toContain('Without potion damage');
    expect(response.text).toContain('Bonus damage');
    expect(response.text).toContain('Purchase price');
    expect(response.text).toContain('Actual rank');
    expect(response.text).toContain('Without potion rank');
    expect(response.text).toContain('Podium entries');
    expect(response.text).toContain('Podium climbs');
    expect(response.text).toContain('Damage 1,000 / 750');
    expect(response.text).toContain('Rank 1 → 2');
    expect(response.text).toContain('Actual 550g / Without potion');
    expect(response.text).toContain('1 podium position climb');
    expect(response.text).toContain('80/10/5/3/2');
    expect(response.text).not.toContain('80/20');
    expect(response.text).toContain('Economy flow');
    expect(response.text).toContain('Ledger reconciled');
    expect(response.text).toContain('Stock purchased');
    expect(response.text).toContain('Doses used');
    expect(response.text).toContain('Tier 2 evidence');
    expect(response.text).toContain('1 / 14 combat days');
    expect(response.text).toContain('Encounter gold is redistributed');
    expect(response.text).not.toContain(boosted.auth_token);
    expect(response.text).not.toContain('auth_token');
  });

  it('interprets date filters at office-local midnight', async () => {
    seedReportRows();
    const agent = await adminAgent();

    const response = await agent.get('/admin/potions').query({ from: '1970-01-01' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('No Gold Potion evidence matches these filters.');
    expect(response.text).not.toContain('50,000g net');
  });

  it.each([
    { from: 'not-a-date' },
    { to: '2026-99-99' },
    { player: 'abc' },
    { player: '0' },
    { player: '9007199254740992' },
    { sku: 'potion_gold_t9' },
    { from: '2026-07-30', to: '2026-07-29' },
  ])('returns 400 for invalid filters: %j', async (query) => {
    const agent = await adminAgent();
    const response = await agent.get('/admin/potions').query(query);
    expect(response.status).toBe(400);
  });
});
