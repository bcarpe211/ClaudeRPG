import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db';

const columns = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name);

describe('012_timed_consumables migration', () => {
  it('creates durable inventory, potion, reward, and ledger records', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'player_inventory')).toEqual([
      'player_id', 'sku', 'quantity', 'updated_at',
    ]);
    expect(columns(db, 'shop_purchases')).toEqual([
      'id', 'player_id', 'sku', 'quantity', 'unit_price', 'total_price',
      'office_day', 'request_id', 'inventory_after', 'gold_after', 'created_at',
    ]);
    expect(columns(db, 'player_inventory_lots')).toEqual([
      'id', 'purchase_id', 'player_id', 'sku', 'remaining_quantity',
      'unit_price', 'purchased_at',
    ]);
    expect(columns(db, 'potion_activations')).toContain('effect_snapshot');
    expect(columns(db, 'potion_activations')).toContain('potion_bonus_damage');
    expect(columns(db, 'potion_activations')).toContain('purchase_unit_price');
    expect(columns(db, 'potion_work_events')).toContain('token_event_id');
    expect(columns(db, 'potion_activation_encounters')).toEqual([
      'activation_id', 'encounter_id', 'bonus_damage',
    ]);
    expect(columns(db, 'encounter_reward_awards')).toContain('podium_gold');
    expect(columns(db, 'gold_ledger')).toContain('balance_after');
    expect(columns(db, 'game_clock_days')).toEqual(['office_day', 'active_ms']);
    expect(columns(db, 'player_daily_combat')).toEqual([
      'player_id', 'office_day', 'damage', 'potion_bonus_damage',
    ]);
  });

  it('adds clock, potion-damage, and reward-snapshot columns', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'game_state')).toContain('combat_active_ms');
    expect(columns(db, 'encounter_damage')).toContain('potion_bonus_damage');
    expect(columns(db, 'encounters')).toEqual(expect.arrayContaining([
      'reward_model_version', 'reward_work_pct', 'reward_damage_pct',
      'reward_podium_first_pct', 'reward_podium_second_pct', 'reward_podium_third_pct',
    ]));
  });

  it('enforces one active potion per type and idempotent source records', () => {
    const db = openDb(':memory:');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      'idx_potion_active_type', 'idx_potion_work_source', 'idx_gold_ledger_source',
    ]));
  });
});
