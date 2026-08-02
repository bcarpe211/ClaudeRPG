import { DEFAULT_SETTINGS } from './settings';

export interface SettingMeta {
  label: string;
  description: string;   // plain language; states the effect of raising/lowering
  group: string;
  unit?: string;
  min?: number; max?: number; step?: number;
}

export const GROUP_ORDER = [
  'Progression', 'Combat', 'Momentum', 'Monster HP & difficulty',
  'Monster retaliation', 'Economy', 'Encounters & pacing', 'Shop', 'Potions',
  'Reward allocation', 'System',
] as const;

export const SETTINGS_META: Record<string, SettingMeta> = {
  // Progression
  base_xp: { group: 'Progression', label: 'Raid Power for level 2', unit: 'Raid Power', min: 1000, step: 1000,
    description: 'Raid Power a Raider needs to reach level 2. Higher levels cost geometrically more (see Raid Power growth). Higher = slower leveling for everyone.' },
  xp_growth: { group: 'Progression', label: 'Raid Power growth per level', unit: '×', min: 1, max: 3, step: 0.05,
    description: "Each level costs this multiple of the previous level's requirement. Higher = later levels get expensive much faster, so levels stay low. 1.0 = every level costs the same." },
  level_curve_slope: { group: 'Progression', label: 'Level damage slope', min: 0, max: 3, step: 0.05,
    description: 'Damage bonus from level: multiplier = 1 + slope × ln(level). Higher = each level adds more damage (still with diminishing returns). 0 = level gives no damage bonus.' },
  // Combat
  base_hit: { group: 'Combat', label: 'Base hit damage', unit: 'dmg', min: 1, step: 1,
    description: 'Damage of one swing at level 1 with no Momentum bonus. Higher = everyone hits harder — but monster HP is sized to office output, so this mostly rescales the numbers rather than the pace.' },
  attack_interval_ms: { group: 'Combat', label: 'Attack interval', unit: 'ms', min: 500, max: 20000, step: 100,
    description: "Milliseconds between a Raider's swings. Lower = Raiders attack more often (more, smaller hits)." },
  attack_jitter_ms: { group: 'Combat', label: 'Attack jitter', unit: 'ms', min: 0, step: 100,
    description: "Random ± spread on the swing interval so Raiders do not all attack in lockstep. Higher = more staggered attacks." },
  // Momentum
  token_modifier_k: { group: 'Momentum', label: 'Raid Power per +1 Momentum', unit: 'Raid Power', min: 100, step: 100,
    description: "Accumulated Raid Power that adds +1.0 to a Raider's Momentum multiplier (multiplier = 1 + score ÷ this). Lower = Raid Power builds Momentum faster." },
  modifier_cap: { group: 'Momentum', label: 'Maximum Momentum', unit: '×', min: 1, step: 10,
    description: "Ceiling on a Raider's Momentum multiplier, so one enormous burst cannot wholly trivialize a Fight. Higher = Momentum can amplify damage further before reaching the cap." },
  decay_after_minutes: { group: 'Momentum', label: 'Momentum hold time', unit: 'min', min: 0, step: 1,
    description: "Minutes with no new Raid Power before a Raider's Momentum starts fading. Higher = Momentum lingers longer after work stops." },
  decay_span_minutes: { group: 'Momentum', label: 'Momentum fade time', unit: 'min', min: 1, step: 1,
    description: 'Once fading starts, minutes until Momentum returns to ×1. Higher = a gentler, slower fade.' },
  // Monster HP & difficulty
  baseline_battle_minutes: { group: 'Monster HP & difficulty', label: 'Quiet-office battle length', unit: 'min', min: 1, step: 1,
    description: "How long a monster lasts at the office's baseline output with no Momentum bonus. New Raid Power shortens it. Higher = tougher, longer monsters." },
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
    description: 'Master switch for the monster striking back at Raiders. 1 = on, 0 = off (monsters never retaliate).' },
  monster_attack_interval_ms: { group: 'Monster retaliation', label: 'Monster strike interval', unit: 'ms', min: 1000, step: 500,
    description: 'Base milliseconds between monster counter-attacks during a Fight. Lower = the monster hits Raiders more often.' },
  monster_attack_jitter_ms: { group: 'Monster retaliation', label: 'Monster strike jitter', unit: 'ms', min: 0, step: 500,
    description: 'Random ± spread on the strike interval so counter-attacks are not perfectly regular. Higher = more variation in timing.' },
  monster_gold_steal_pct: { group: 'Monster retaliation', label: 'Gold stolen per hit', unit: '% of held', min: 0, step: 0.001,
    description: "Percent of a Raider's current gold a monster hit steals (0.008 = 0.008%), floored at 1. Scales with wealth so it stays meaningful as gold inflates. A broke Raider is debuffed instead." },
  monster_debuff_factor: { group: 'Monster retaliation', label: 'Debuff damage multiplier', unit: '×', min: 0, max: 1, step: 0.05,
    description: 'Swing-damage multiplier while a Raider is debuffed by a monster hit (0.85 = 15% weaker). Lower = a harsher debuff. 1.0 = the debuff does nothing.' },
  monster_debuff_seconds: { group: 'Monster retaliation', label: 'Debuff duration', unit: 's', min: 1, step: 1,
    description: 'How many seconds a monster debuff lasts before a Raider returns to full strength. Higher = the weakening lingers longer.' },
  // Economy
  gold_factor: { group: 'Economy', label: 'Gold per kill', min: 0, step: 0.005,
    description: 'Gold pool for a kill = monster max HP × dungeon level × this. Higher = more gold awarded per monster.' },
  gold_damage_weight: { group: 'Economy', label: 'Legacy gold: raw tokens vs damage', unit: '0–1', min: 0, max: 1, step: 0.1,
    description: 'Legacy OTLP only; inactive for new Runtime Raiders encounters. For encounters already marked legacy-v0, 0 = purely by raw tokens and 1 = purely by damage dealt.' },
  // Encounters & pacing
  regular_encounters_min: { group: 'Encounters & pacing', label: 'Min monsters before boss', unit: 'count', min: 0, step: 1,
    description: "Fewest regular monsters cleared before a dungeon's boss appears." },
  regular_encounters_max: { group: 'Encounters & pacing', label: 'Max monsters before boss', unit: 'count', min: 0, step: 1,
    description: 'Most regular monsters before the boss (the actual count is random between min and max).' },
  popup_duration_s: { group: 'Encounters & pacing', label: 'Victory screen seconds', unit: 's', min: 0, step: 5,
    description: 'How long the victory summary stays on the TV before the next monster spawns. Higher = Raiders have longer to read the results.' },
  pause_after_minutes: { group: 'Encounters & pacing', label: 'Idle-pause delay', unit: 'min', min: 1, step: 1,
    description: 'Office-wide minutes with no new Raid Power before the game pauses ("the dungeon rests"). Higher = the game keeps running through longer lulls.' },
  // Shop
  cosmetic_wheel_t1_price: { group: 'Shop', label: 'Dye wheel (T1) price', unit: 'gold', min: 0, step: 10000,
    description: 'Gold to unlock the Tier-1 clothing color wheel. Cosmetic only (no combat effect). Recoloring is free once unlocked.' },
  cosmetic_wheel_t2_price: { group: 'Shop', label: 'Dye wheel (T2) price', unit: 'gold', min: 0, step: 10000,
    description: 'Gold to unlock Tier-2 detail channels after Tier 1. Cosmetic only; recoloring remains free.' },
  cosmetic_wheel_t3_price: { group: 'Shop', label: 'Dye wheel (T3) price', unit: 'gold', min: 0, step: 10000,
    description: 'Gold to unlock Tier-3 weapon, shield, and equipment channels after Tier 2. Cosmetic only.' },
  // Potions
  potion_gold_t1_price: { group: 'Potions', label: 'Gold Potion (T1) price', unit: 'gold', min: 0, step: 1000,
    description: 'Gold required for each future Beginner Gold Potion purchase. Higher = the potion costs more.' },
  potion_gold_t1_duration_s: { group: 'Potions', label: 'Gold Potion (T1) duration', unit: 's', min: 1, step: 60,
    description: 'Combat-active seconds for future Beginner Gold Potion activations. Higher = its work-reward window lasts longer.' },
  potion_gold_t1_gold_per_1000: { group: 'Potions', label: 'Gold Potion reward per 1,000 Raid Power', unit: 'gold', min: 0, step: 1,
    description: 'Gold awarded for each whole 1,000 eligible Raid Power during a future Gold Potion activation. Higher = more work reward.' },
  potion_gold_t1_base_cap: { group: 'Potions', label: 'Gold Potion base reward cap', unit: 'gold', min: 0, step: 1000,
    description: 'Maximum base gold a future Gold Potion activation can award before its stretch bonus. Higher = a larger possible base payout.' },
  potion_gold_t1_stretch_tokens: { group: 'Potions', label: 'Gold Potion Raid Power goal', unit: 'Raid Power', min: 0, step: 1000,
    description: 'Eligible Raid Power needed for a future Gold Potion activation to earn its one-time stretch bonus. Higher = harder completion goal.' },
  potion_gold_t1_stretch_bonus: { group: 'Potions', label: 'Gold Potion stretch bonus', unit: 'gold', min: 0, step: 1000,
    description: 'One-time bonus for a future Gold Potion activation that reaches its Raid Power goal. Higher = a larger completion reward.' },
  potion_damage_t1_price: { group: 'Potions', label: 'Damage Potion (T1) price', unit: 'gold', min: 0, step: 1000,
    description: 'Gold required for each future Beginner Damage Potion purchase. Higher = the potion costs more.' },
  potion_damage_t1_duration_s: { group: 'Potions', label: 'Damage Potion (T1) duration', unit: 's', min: 1, step: 60,
    description: 'Combat-active seconds for future Beginner Damage Potion activations. Higher = its damage window lasts longer.' },
  potion_damage_t1_base_hit_pct: { group: 'Potions', label: 'Damage Potion base-hit bonus', unit: '%', min: 0, step: 1,
    description: 'Percent added to personal base hit for future Damage Potion activations before level, Momentum, and debuff multipliers. Higher = stronger potion hits.' },
  potion_daily_stock_per_sku: { group: 'Potions', label: 'Daily potion stock per SKU', unit: 'count', min: 0, step: 1,
    description: 'How many units of each future potion SKU a Raider may buy per local office day. Higher = more daily purchases.' },
  potion_daily_uses_per_type: { group: 'Potions', label: 'Daily potion uses per type', unit: 'count', min: 0, step: 1,
    description: 'How many activations of each future potion type a Raider may start per local office day. Higher = more daily uses.' },
  // Reward allocation
  reward_work_pct: { group: 'Reward allocation', label: 'Encounter reward: Raid Power share', unit: '%', min: 0, max: 100, step: 1,
    description: 'Percent of a newly spawned encounter reward pool allocated by Raid Power contribution. Higher = Raid Power contributes more to rewards.' },
  reward_damage_pct: { group: 'Reward allocation', label: 'Encounter reward: damage share', unit: '%', min: 0, max: 100, step: 1,
    description: 'Percent of a newly spawned encounter reward pool allocated by damage contribution. Higher = damage contributes more to rewards.' },
  reward_podium_first_pct: { group: 'Reward allocation', label: 'Encounter reward: first-place podium', unit: '%', min: 0, max: 100, step: 1,
    description: 'Percent of a newly spawned encounter reward pool awarded to the top damage rank. Higher = first place is more valuable.' },
  reward_podium_second_pct: { group: 'Reward allocation', label: 'Encounter reward: second-place podium', unit: '%', min: 0, max: 100, step: 1,
    description: 'Percent of a newly spawned encounter reward pool awarded to the second damage rank. Higher = second place is more valuable.' },
  reward_podium_third_pct: { group: 'Reward allocation', label: 'Encounter reward: third-place podium', unit: '%', min: 0, max: 100, step: 1,
    description: 'Percent of a newly spawned encounter reward pool awarded to the third damage rank. Higher = third place is more valuable.' },
  // System
  cache_read_weight: { group: 'System', label: 'Legacy cache-read weight', unit: '0–1', min: 0, max: 1, step: 0.05,
    description: 'Legacy OTLP only; inactive in Runtime Raiders mode. Retained as an internal compatibility setting for old OTLP scoring.' },
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
