import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/domain/settings';
import { SETTINGS_META, GROUP_ORDER, groupedSettings } from '../src/domain/settings-meta';

describe('settings metadata', () => {
  it('has metadata for every setting and no orphans', () => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) expect(SETTINGS_META[key], key).toBeDefined();
    for (const key of Object.keys(SETTINGS_META)) expect(DEFAULT_SETTINGS[key], key).toBeDefined();
  });
  it('every entry has a valid group and non-empty label/description', () => {
    for (const [key, m] of Object.entries(SETTINGS_META)) {
      expect(GROUP_ORDER as readonly string[], key).toContain(m.group);
      expect(m.label.length, key).toBeGreaterThan(0);
      expect(m.description.length, key).toBeGreaterThan(0);
    }
  });
  it('groups every launch potion and reward setting', () => {
    const potionKeys = [
      'potion_gold_t1_price', 'potion_gold_t1_duration_s',
      'potion_gold_t1_gold_per_1000', 'potion_gold_t1_base_cap',
      'potion_gold_t1_stretch_tokens', 'potion_gold_t1_stretch_bonus',
      'potion_damage_t1_price', 'potion_damage_t1_duration_s',
      'potion_damage_t1_base_hit_pct', 'potion_daily_stock_per_sku',
      'potion_daily_uses_per_type',
    ];
    const rewardKeys = [
      'reward_work_pct', 'reward_damage_pct', 'reward_podium_first_pct',
      'reward_podium_second_pct', 'reward_podium_third_pct',
    ];
    for (const key of potionKeys) {
      expect(DEFAULT_SETTINGS[key], key).toBeDefined();
      expect(SETTINGS_META[key]?.group, key).toBe('Potions');
    }
    for (const key of rewardKeys) {
      expect(DEFAULT_SETTINGS[key], key).toBeDefined();
      expect(SETTINGS_META[key]?.group, key).toBe('Reward allocation');
    }
    expect(GROUP_ORDER).toContain('Potions');
    expect(GROUP_ORDER).toContain('Reward allocation');
  });
  it('groupedSettings covers every key once, in GROUP_ORDER', () => {
    const groups = groupedSettings(DEFAULT_SETTINGS);
    const order = groups.map((g) => g.group);
    expect(order).toEqual([...GROUP_ORDER].filter((g) => order.includes(g)));
    const keys = groups.flatMap((g) => g.items.map((i) => i.key));
    expect(keys.slice().sort()).toEqual(Object.keys(DEFAULT_SETTINGS).slice().sort());
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of groups) for (const it of g.items) {
      expect(it.default, it.key).toBe(DEFAULT_SETTINGS[it.key]);
      expect(it.value, it.key).toBe(DEFAULT_SETTINGS[it.key]);
    }
  });
  it('reflects an override in value while keeping default', () => {
    const groups = groupedSettings({ ...DEFAULT_SETTINGS, base_hit: '250' });
    const item = groups.flatMap((x) => x.items).find((i) => i.key === 'base_hit')!;
    expect(item.value).toBe('250');
    expect(item.default).toBe(DEFAULT_SETTINGS.base_hit);
  });

  it('presents Runtime Raiders terms while preserving compatibility setting keys', () => {
    expect(SETTINGS_META.base_xp).toMatchObject({
      label: 'Raid Power for level 2',
      unit: 'Raid Power',
    });
    expect(SETTINGS_META.token_modifier_k).toMatchObject({
      label: 'Raid Power per +1 Momentum',
      unit: 'Raid Power',
    });
    expect(SETTINGS_META.modifier_cap.label).toBe('Maximum Momentum');
    expect(SETTINGS_META.reward_work_pct.description).toContain('Raid Power contribution');
    expect(SETTINGS_META.cache_read_weight).toMatchObject({
      label: 'Legacy cache-read weight',
      unit: '0–1',
    });
    expect(SETTINGS_META.cache_read_weight.description).toContain(
      'Legacy OTLP only; inactive in Runtime Raiders mode.',
    );

    const items = groupedSettings(DEFAULT_SETTINGS).flatMap((group) => group.items);
    expect(items.find((item) => item.key === 'token_modifier_k')?.label)
      .toBe('Raid Power per +1 Momentum');
    expect(items.find((item) => item.key === 'cache_read_weight')?.label)
      .toBe('Legacy cache-read weight');
  });

  it('describes Damage Potion ordering with the Momentum multiplier', () => {
    expect(SETTINGS_META.potion_damage_t1_base_hit_pct.description).toContain(
      'before level, Momentum, and debuff multipliers',
    );
    expect(SETTINGS_META.potion_damage_t1_base_hit_pct.description)
      .not.toContain('activity');
  });
});
