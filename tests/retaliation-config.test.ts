import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings, DEFAULT_SETTINGS } from '../src/domain/settings';
import { loadEngineConfig } from '../src/domain/encounters';
import { SETTINGS_META } from '../src/domain/settings-meta';

const KEYS = ['monster_attacks_enabled', 'monster_attack_interval_ms', 'monster_attack_jitter_ms',
  'monster_gold_steal', 'monster_debuff_factor', 'monster_debuff_seconds'];

describe('monster-retaliation settings', () => {
  it('defines defaults + metadata for every new key', () => {
    for (const k of KEYS) {
      expect(DEFAULT_SETTINGS[k], k).toBeDefined();
      expect(SETTINGS_META[k], k).toBeDefined();
      expect(SETTINGS_META[k].group).toBe('Monster retaliation');
    }
  });

  it('loadEngineConfig reads the new knobs with defaults', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const cfg = loadEngineConfig(db);
    expect(cfg.monsterAttacksEnabled).toBe(1);
    expect(cfg.monsterAttackIntervalMs).toBe(15000);
    expect(cfg.monsterAttackJitterMs).toBe(5000);
    expect(cfg.monsterGoldSteal).toBe(5);
    expect(cfg.monsterDebuffFactor).toBeCloseTo(0.85);
    expect(cfg.monsterDebuffSeconds).toBe(8);
  });
});
