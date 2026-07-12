# Plain-Language Admin Settings — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending spec review
**Backlog:** #11

## Goal

Replace the raw-key admin settings form with a grouped, self-explaining page:
each knob shows a friendly label, a plain-language description (including what
raising/lowering does), its unit, its default, and a per-setting reset — so the
game can be tuned on the TV without reading source. A coverage test keeps the
metadata in lock-step with `DEFAULT_SETTINGS` so no future knob ships raw.

## Motivation

`admin-settings.ejs` renders `Object.keys(DEFAULT_SETTINGS).sort()` as raw
`key` labels + text inputs. There's no way to tell what `token_modifier_k` or
`baseline_battle_minutes` do or which direction to nudge them — and the #9
redesign just added five such knobs.

## Architecture

| File | Change |
|------|--------|
| `src/domain/settings-meta.ts` (new) | `SettingMeta` type, `SETTINGS_META` (one entry per setting), `GROUP_ORDER`, `groupedSettings(values)` view-model helper. |
| `tests/settings-meta.test.ts` (new) | Coverage/sync test: every `DEFAULT_SETTINGS` key has metadata, no orphans, valid groups, `groupedSettings` shape. |
| `src/web/routes/admin.ts` | GET `/admin/settings` builds the grouped view-model via `groupedSettings`; POST unchanged. |
| `src/web/views/admin-settings.ejs` | Render grouped sections: label + unit, description, number input (min/max/step), default, reset button. |
| `tests/web-admin-settings.test.ts` | Assert friendly labels/descriptions/defaults render; still persists an edit. |

## Component 1 — `src/domain/settings-meta.ts`

```ts
import { DEFAULT_SETTINGS } from './settings';

export interface SettingMeta {
  label: string;
  description: string;   // plain language; states the effect of raising/lowering
  group: string;
  unit?: string;
  min?: number; max?: number; step?: number;  // soft number-input hints
}

export const GROUP_ORDER = [
  'Progression', 'Combat', 'Activity modifier', 'Monster HP & difficulty',
  'Economy', 'Encounters & pacing', 'System',
] as const;

export const SETTINGS_META: Record<string, SettingMeta> = { /* authored below */ };

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
    (buckets.get(meta.group) ?? buckets.set(meta.group, []).get(meta.group)!).push(item);
  }
  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({ group: g, items: buckets.get(g)! }));
}
```

### Authored metadata (all 22 settings — review these descriptions)

**Progression**
- `base_xp` — label **"XP for level 2"**, unit `tokens`, min 1000 step 1000. *"Effective tokens a player needs to reach level 2. Higher levels cost geometrically more (see XP growth). Higher = slower leveling for everyone."*
- `xp_growth` — label **"XP growth per level"**, unit `×`, min 1 max 3 step 0.05. *"Each level costs this multiple of the previous level's requirement. Higher = later levels get expensive much faster, so levels stay low. 1.0 = every level costs the same."*
- `level_curve_slope` — label **"Level damage slope"**, min 0 max 3 step 0.05. *"Damage bonus from level: multiplier = 1 + slope × ln(level). Higher = each level adds more damage (still with diminishing returns). 0 = level gives no damage bonus."*

**Combat**
- `base_hit` — label **"Base hit damage"**, unit `dmg`, min 1 step 1. *"Damage of one swing at level 1 with no activity bonus. Higher = everyone hits harder — but monster HP is sized to office output, so this mostly rescales the numbers rather than the pace."*
- `attack_interval_ms` — label **"Attack interval"**, unit `ms`, min 500 max 20000 step 100. *"Milliseconds between a player's swings. Lower = players attack more often (more, smaller hits)."*
- `attack_jitter_ms` — label **"Attack jitter"**, unit `ms`, min 0 step 100. *"Random ± spread on the swing interval so players don't all attack in lockstep. Higher = more staggered attacks."*

**Activity modifier**
- `token_modifier_k` — label **"Tokens per +1 damage ×"**, unit `tokens`, min 100 step 100. *"Accumulated session tokens that add +1.0 to a player's damage multiplier (multiplier = 1 + score ÷ this). Lower = burning tokens boosts damage faster."*
- `decay_after_minutes` — label **"Modifier hold time"**, unit `min`, min 0 step 1. *"Minutes of no tokens before a player's activity bonus starts fading. Higher = the bonus lingers longer after you stop working."*
- `decay_span_minutes` — label **"Modifier fade time"**, unit `min`, min 1 step 1. *"Once fading starts, how many minutes until the activity bonus reaches zero (back to ×1). Higher = a gentler, slower fade."*

**Monster HP & difficulty**
- `baseline_battle_minutes` — label **"Quiet-office battle length"**, unit `min`, min 1 step 1. *"How long a monster lasts at the office's baseline output with NO activity bonus. Real token activity shortens it. Higher = tougher, longer monsters."*
- `min_encounter_hp` — label **"Minimum monster HP"**, unit `HP`, min 1 step 100. *"A floor on monster HP so early or quiet battles are never trivially short."*
- `boss_hp_mult` — label **"Boss HP multiplier"**, unit `×`, min 1 step 0.5. *"A boss has this many times the HP of a regular monster at the same depth. Higher = beefier bosses."*
- `difficulty_ramp_per_encounter` — label **"Difficulty per encounter"**, unit `×/enc`, min 0 max 2 step 0.05. *"Extra HP for each encounter deeper into a dungeon (0.15 = +15% on the 2nd, +30% on the 3rd…). Higher = later fights in a dungeon get harder faster."*
- `difficulty_ramp_per_dungeon` — label **"Difficulty per dungeon"**, unit `×/lvl`, min 0 max 2 step 0.05. *"Extra HP for each dungeon level descended (0.25 = +25% per level). Higher = deeper dungeons ramp up faster."*

**Economy**
- `gold_factor` — label **"Gold per kill"**, min 0 step 0.005. *"Gold pool for a kill = monster max HP × dungeon level × this. Higher = more gold awarded per monster."*
- `gold_damage_weight` — label **"Gold: tokens vs damage"**, unit `0–1`, min 0 max 1 step 0.1. *"How the gold pool is split. 0 = purely by tokens burned during the fight (rewards work regardless of level); 1 = purely by damage dealt. In between blends the two."*

**Encounters & pacing**
- `regular_encounters_min` — label **"Min monsters before boss"**, unit `count`, min 0 step 1. *"Fewest regular monsters cleared before a dungeon's boss appears."*
- `regular_encounters_max` — label **"Max monsters before boss"**, unit `count`, min 0 step 1. *"Most regular monsters before the boss (the actual count is random between min and max)."*
- `popup_duration_s` — label **"Victory screen seconds"**, unit `s`, min 0 step 5. *"How long the victory summary stays on the TV before the next monster spawns. Higher = players have longer to read the results."*
- `pause_after_minutes` — label **"Idle-pause delay"**, unit `min`, min 1 step 1. *"Office-wide minutes with no tokens from anyone before the game pauses (\"the dungeon rests\"). Higher = the game keeps running through longer lulls."*

**System**
- `cache_read_weight` — label **"Cache-read token weight"**, unit `0–1`, min 0 max 1 step 0.05. *"Fraction of cache-read tokens counted toward effective tokens (XP + damage). 0 = ignore cache reads; 1 = count them fully. Cache reads are cheap, so they're usually discounted."*
- `tick_interval_ms` — label **"Engine tick rate"**, unit `ms`, min 100 max 10000 step 100. *"How often (ms) the game engine advances in production. Lower = smoother but more CPU. Advanced — rarely needs changing."*

## Component 2 — `src/web/routes/admin.ts`

GET `/admin/settings`: keep reading `getAllSettings` + `DEFAULT_SETTINGS` fallbacks into a `values` map, then pass `groups: groupedSettings(values)` to the view (instead of the flat `settings` map). POST `/admin/settings` is **unchanged** (still iterates `Object.keys(DEFAULT_SETTINGS)`, saves non-empty values).

## Component 3 — `src/web/views/admin-settings.ejs`

Render each group as a `<fieldset>`/section with a heading, then a row per item:
- friendly `label` + `unit` (e.g. "Attack interval (ms)"),
- the `description` as helper text,
- a `<input type="number">` with `value`, and `min`/`max`/`step` when present (fall back to `step="any"` for non-integer defaults),
- "default: `<default>`" text,
- a **reset** button (`type="button"`) carrying `data-default`; a small inline script sets the field back to its default on click. The single "Save settings" button still submits the whole form.

Keep the existing panel styling; add minimal CSS for group headings + description text (muted, smaller). No new server route for reset (client-side only).

## Testing

**`tests/settings-meta.test.ts`**
- Every `DEFAULT_SETTINGS` key has a `SETTINGS_META` entry; every `SETTINGS_META` key exists in `DEFAULT_SETTINGS` (no orphans).
- Every `meta.group` is in `GROUP_ORDER`; `label` and `description` are non-empty.
- `groupedSettings(DEFAULT_SETTINGS)` returns groups in `GROUP_ORDER` order, and the union of all items' keys equals `Object.keys(DEFAULT_SETTINGS)` exactly once each. Each item's `default` matches `DEFAULT_SETTINGS[key]`, and `value` reflects an override when passed.

**`tests/web-admin-settings.test.ts`** (update)
- GET renders a friendly label and a description substring (not just the raw key), and shows a default value.
- POST still persists an edit to a surviving key (e.g. `baseline_battle_minutes`).

Full suite + `tsc --noEmit` stay green (baseline 224).

## Risks / notes

- **Soft validation only**: `min`/`max`/`step` are HTML hints; the POST handler stays lenient (no hard clamp) — matches the "hints" scope. A later task could add server-side clamping if desired.
- **Reset is client-side**: it fills the input with the default; you still click Save to persist. No new route, no accidental immediate writes.
- The coverage test is the durable guard — adding a knob to `DEFAULT_SETTINGS` without metadata fails the suite.
