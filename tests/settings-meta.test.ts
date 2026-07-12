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
});
