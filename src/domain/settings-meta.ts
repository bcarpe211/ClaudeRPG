import { DEFAULT_SETTINGS } from './settings';

export interface SettingMeta {
  label: string;
  description: string;   // plain language; states the effect of raising/lowering
  group: string;
  unit?: string;
  min?: number; max?: number; step?: number;
}

export const GROUP_ORDER = [
  'Progression', 'Combat', 'Activity modifier', 'Monster HP & difficulty',
  'Monster retaliation', 'Economy', 'Encounters & pacing', 'System',
] as const;

export const SETTINGS_META: Record<string, SettingMeta> = {
  // Progression
  base_xp: { group: 'Progression', label: 'XP for level 2', unit: 'tokens', min: 1000, step: 1000,
    description: 'Effective tokens a player needs to reach level 2. Higher levels cost geometrically more (see XP growth). Higher = slower leveling for everyone.' },
  xp_growth: { group: 'Progression', label: 'XP growth per level', unit: '×', min: 1, max: 3, step: 0.05,
    description: "Each level costs this multiple of the previous level's requirement. Higher = later levels get expensive much faster, so levels stay low. 1.0 = every level costs the same." },
  level_curve_slope: { group: 'Progression', label: 'Level damage slope', min: 0, max: 3, step: 0.05,
    description: 'Damage bonus from level: multiplier = 1 + slope × ln(level). Higher = each level adds more damage (still with diminishing returns). 0 = level gives no damage bonus.' },
  // Combat
  base_hit: { group: 'Combat', label: 'Base hit damage', unit: 'dmg', min: 1, step: 1,
    description: 'Damage of one swing at level 1 with no activity bonus. Higher = everyone hits harder — but monster HP is sized to office output, so this mostly rescales the numbers rather than the pace.' },
  attack_interval_ms: { group: 'Combat', label: 'Attack interval', unit: 'ms', min: 500, max: 20000, step: 100,
    description: "Milliseconds between a player's swings. Lower = players attack more often (more, smaller hits)." },
  attack_jitter_ms: { group: 'Combat', label: 'Attack jitter', unit: 'ms', min: 0, step: 100,
    description: "Random ± spread on the swing interval so players don't all attack in lockstep. Higher = more staggered attacks." },
  // Activity modifier
  token_modifier_k: { group: 'Activity modifier', label: 'Tokens per +1 damage ×', unit: 'tokens', min: 100, step: 100,
    description: "Accumulated session tokens that add +1.0 to a player's damage multiplier (multiplier = 1 + score ÷ this). Lower = burning tokens boosts damage faster." },
  modifier_cap: { group: 'Activity modifier', label: 'Max damage multiplier', unit: '×', min: 1, step: 10,
    description: "Ceiling on a player's activity multiplier, so one enormous burst can't wholly trivialize a fight. Higher = whales can hit even harder before the cap bites." },
  decay_after_minutes: { group: 'Activity modifier', label: 'Modifier hold time', unit: 'min', min: 0, step: 1,
    description: "Minutes of no tokens before a player's activity bonus starts fading. Higher = the bonus lingers longer after you stop working." },
  decay_span_minutes: { group: 'Activity modifier', label: 'Modifier fade time', unit: 'min', min: 1, step: 1,
    description: 'Once fading starts, how many minutes until the activity bonus reaches zero (back to ×1). Higher = a gentler, slower fade.' },
  // Monster HP & difficulty
  baseline_battle_minutes: { group: 'Monster HP & difficulty', label: 'Quiet-office battle length', unit: 'min', min: 1, step: 1,
    description: "How long a monster lasts at the office's baseline output with NO activity bonus. Real token activity shortens it. Higher = tougher, longer monsters." },
  min_encounter_hp: { group: 'Monster HP & difficulty', label: 'Minimum monster HP', unit: 'HP', min: 1, step: 100,
    description: 'A floor on monster HP so early or quiet battles are never trivially short.' },
  boss_hp_mult: { group: 'Monster HP & difficulty', label: 'Boss HP multiplier', unit: '×', min: 1, step: 0.5,
    description: 'A boss has this many times the HP of a regular monster at the same depth. Higher = beefier bosses.' },
  difficulty_ramp_per_encounter: { group: 'Monster HP & difficulty', label: 'Difficulty per encounter', unit: '×/enc', min: 0, max: 2, step: 0.05,
    description: 'Extra HP for each encounter deeper into a dungeon (0.15 = +15% on the 2nd, +30% on the 3rd…). Higher = later fights in a dungeon get harder faster.' },
  difficulty_ramp_per_dungeon: { group: 'Monster HP & difficulty', label: 'Difficulty per dungeon', unit: '×/lvl', min: 0, max: 2, step: 0.05,
    description: 'Extra HP for each dungeon level descended (0.25 = +25% per level). Higher = deeper dungeons ramp up faster.' },
  // Monster retaliation
  monster_attacks_enabled: { group: 'Monster retaliation', label: 'Monster attacks back', unit: '0/1', min: 0, max: 1, step: 1,
    description: 'Master switch for the monster striking back at players. 1 = on, 0 = off (monsters never retaliate).' },
  monster_attack_interval_ms: { group: 'Monster retaliation', label: 'Monster strike interval', unit: 'ms', min: 1000, step: 500,
    description: 'Base milliseconds between monster counter-attacks during a fight. Lower = the monster hits players more often.' },
  monster_attack_jitter_ms: { group: 'Monster retaliation', label: 'Monster strike jitter', unit: 'ms', min: 0, step: 500,
    description: 'Random ± spread on the strike interval so counter-attacks are not perfectly regular. Higher = more variation in timing.' },
  monster_gold_steal_pct: { group: 'Monster retaliation', label: 'Gold stolen per hit', unit: '% of held', min: 0, step: 0.001,
    description: "Percent of a player's CURRENT gold a monster hit steals (0.008 = 0.008%), floored at 1. Scales with wealth so it stays meaningful as gold inflates. A broke player is debuffed instead." },
  monster_debuff_factor: { group: 'Monster retaliation', label: 'Debuff damage multiplier', unit: '×', min: 0, max: 1, step: 0.05,
    description: 'Swing-damage multiplier while a player is debuffed by a monster hit (0.85 = 15% weaker). Lower = a harsher debuff. 1.0 = the debuff does nothing.' },
  monster_debuff_seconds: { group: 'Monster retaliation', label: 'Debuff duration', unit: 's', min: 1, step: 1,
    description: 'How many seconds a monster debuff lasts before a player returns to full strength. Higher = the weakening lingers longer.' },
  // Economy
  gold_factor: { group: 'Economy', label: 'Gold per kill', min: 0, step: 0.005,
    description: 'Gold pool for a kill = monster max HP × dungeon level × this. Higher = more gold awarded per monster.' },
  gold_damage_weight: { group: 'Economy', label: 'Gold: tokens vs damage', unit: '0–1', min: 0, max: 1, step: 0.1,
    description: 'How the gold pool is split. 0 = purely by tokens burned during the fight (rewards work regardless of level); 1 = purely by damage dealt. In between blends the two.' },
  // Encounters & pacing
  regular_encounters_min: { group: 'Encounters & pacing', label: 'Min monsters before boss', unit: 'count', min: 0, step: 1,
    description: "Fewest regular monsters cleared before a dungeon's boss appears." },
  regular_encounters_max: { group: 'Encounters & pacing', label: 'Max monsters before boss', unit: 'count', min: 0, step: 1,
    description: 'Most regular monsters before the boss (the actual count is random between min and max).' },
  popup_duration_s: { group: 'Encounters & pacing', label: 'Victory screen seconds', unit: 's', min: 0, step: 5,
    description: 'How long the victory summary stays on the TV before the next monster spawns. Higher = players have longer to read the results.' },
  pause_after_minutes: { group: 'Encounters & pacing', label: 'Idle-pause delay', unit: 'min', min: 1, step: 1,
    description: 'Office-wide minutes with no tokens from anyone before the game pauses ("the dungeon rests"). Higher = the game keeps running through longer lulls.' },
  // System
  cache_read_weight: { group: 'System', label: 'Cache-read token weight', unit: '0–1', min: 0, max: 1, step: 0.05,
    description: "Fraction of cache-read tokens counted toward effective tokens (XP + damage). 0 = ignore cache reads; 1 = count them fully. Cache reads are cheap, so they're usually discounted." },
  tick_interval_ms: { group: 'System', label: 'Engine tick rate', unit: 'ms', min: 100, max: 10000, step: 100,
    description: 'How often (ms) the game engine advances in production. Lower = smoother but more CPU. Advanced — rarely needs changing.' },
};

export interface GroupedItem {
  key: string; label: string; description: string; unit?: string;
  value: string; default: string;
  min?: number; max?: number; step?: number;
}
export interface SettingsGroup { group: string; items: GroupedItem[]; }

/** Group current settings for display, in GROUP_ORDER, preserving DEFAULT_SETTINGS key order within a group. */
export function groupedSettings(values: Record<string, string>): SettingsGroup[] {
  const buckets = new Map<string, GroupedItem[]>();
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const meta = SETTINGS_META[key];
    if (!meta) continue; // coverage test guarantees this never happens
    const item: GroupedItem = {
      key, label: meta.label, description: meta.description, unit: meta.unit,
      value: values[key] ?? DEFAULT_SETTINGS[key], default: DEFAULT_SETTINGS[key],
      min: meta.min, max: meta.max, step: meta.step,
    };
    if (!buckets.has(meta.group)) buckets.set(meta.group, []);
    buckets.get(meta.group)!.push(item);
  }
  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({ group: g, items: buckets.get(g)! }));
}
