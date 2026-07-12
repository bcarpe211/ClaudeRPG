# Plain-Language Admin Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the raw-key admin settings form into a grouped, self-explaining page (friendly label, plain-language description, unit, default, per-setting reset), backed by a metadata registry with a coverage test.

**Architecture:** A new pure domain module `settings-meta.ts` holds per-setting metadata + a `groupedSettings()` view-model helper. The admin GET route feeds that view-model to a redesigned EJS page. The POST route is untouched.

**Tech Stack:** TypeScript ESM via `tsx` (no build), EJS views via `renderPage`, vitest, supertest.

Spec: `docs/superpowers/specs/2026-07-12-admin-settings-descriptions-design.md`.

## Global Constraints

- **No build step.** Typecheck `npm run typecheck`; tests `npx vitest run <file>`.
- **Inputs keep `name="<key>"`** so the unchanged POST handler still saves. The POST handler is NOT modified.
- **Coverage test is the guard**: every `DEFAULT_SETTINGS` key must have metadata; the suite fails otherwise.
- **Only render `DEFAULT_SETTINGS` keys** — never `admin_*` credential keys (existing invariant; the test asserts it).
- Suite stays green (baseline 224).

## File Structure

- Create: `src/domain/settings-meta.ts`, `tests/settings-meta.test.ts`
- Modify: `src/web/routes/admin.ts` (GET `/admin/settings` only)
- Modify: `src/web/views/admin-settings.ejs`
- Modify: `tests/web-admin-settings.test.ts`

---

## Task 1: Settings metadata registry

**Files:** Create `src/domain/settings-meta.ts`, Test `tests/settings-meta.test.ts`
**Interfaces:**
- Consumes: `DEFAULT_SETTINGS` (from `./settings`).
- Produces: `SettingMeta`, `SETTINGS_META`, `GROUP_ORDER`, `GroupedItem`, `SettingsGroup`, `groupedSettings(values)`.

- [ ] **Step 1: Write the failing test** — `tests/settings-meta.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/settings-meta.test.ts` FAIL (module not found).

- [ ] **Step 3: Write `src/domain/settings-meta.ts`**

```ts
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
  'Economy', 'Encounters & pacing', 'System',
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
```

- [ ] **Step 4: Run tests to verify pass** — `npx vitest run tests/settings-meta.test.ts` PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/domain/settings-meta.ts tests/settings-meta.test.ts && git commit -m "feat(settings): metadata registry + groupedSettings view-model"`

---

## Task 2: Grouped admin settings page

**Files:** Modify `src/web/routes/admin.ts`, `src/web/views/admin-settings.ejs`, `tests/web-admin-settings.test.ts`
**Interfaces:** Consumes `groupedSettings` (settings-meta).

- [ ] **Step 1: Update the route test** — replace the "shows the tunable knobs" test in `tests/web-admin-settings.test.ts` (keep the other two tests as-is):

```ts
  it('shows friendly labels, descriptions, and defaults (not just raw keys)', async () => {
    const agent = await adminAgent();
    const res = await agent.get('/admin/settings');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="pause_after_minutes"'); // input still posts by raw key
    expect(res.text).toContain('Idle-pause delay');           // friendly label
    expect(res.text).toContain('the dungeon rests');          // description text
    expect(res.text).toContain('default:');                   // default shown
    expect(res.text).toContain('Activity modifier');          // a group heading
  });
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/web-admin-settings.test.ts` FAIL (labels/description/default not rendered yet).

- [ ] **Step 3: Update the GET handler** in `src/web/routes/admin.ts`.
Add the import near the other domain imports:
```ts
import { groupedSettings } from '../../domain/settings-meta';
```
Replace the GET `/admin/settings` handler body:
```ts
    asyncHandler(async (_req, res) => {
      const all = getAllSettings(db);
      // Only expose the known game knobs, never admin_* credential keys.
      const values: Record<string, string> = {};
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        values[key] = all[key] ?? DEFAULT_SETTINGS[key];
      }
      res.send(await renderPage('admin-settings', { title: 'Settings', groups: groupedSettings(values) }));
    }),
```
(POST handler unchanged.)

- [ ] **Step 4: Rewrite `src/web/views/admin-settings.ejs`**

```ejs
<div class="panel">
  <h1>Game settings</h1>
  <p>Each knob is read live by the game engine. Edit values and click Save. Ranges are hints, not hard limits.</p>
  <form method="post" action="/admin/settings">
    <% groups.forEach(function (g) { %>
      <fieldset class="settings-group">
        <legend><%= g.group %></legend>
        <% g.items.forEach(function (s) { %>
          <div class="setting-row">
            <label for="<%= s.key %>"><%= s.label %><% if (s.unit) { %> <span class="unit">(<%= s.unit %>)</span><% } %></label>
            <p class="setting-desc"><%= s.description %></p>
            <div class="setting-input">
              <input type="number" id="<%= s.key %>" name="<%= s.key %>" value="<%= s.value %>"
                <% if (s.min !== undefined) { %>min="<%= s.min %>"<% } %>
                <% if (s.max !== undefined) { %>max="<%= s.max %>"<% } %>
                step="<%= s.step !== undefined ? s.step : 'any' %>"
                data-default="<%= s.default %>" />
              <span class="setting-default">default: <%= s.default %></span>
              <button type="button" class="reset-btn" data-target="<%= s.key %>">reset</button>
            </div>
          </div>
        <% }) %>
      </fieldset>
    <% }) %>
    <button type="submit">Save settings</button>
  </form>
  <p style="margin-top:16px;"><a href="/admin">← Back to players</a></p>
  <script>
    document.querySelectorAll('.reset-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var input = document.getElementById(b.dataset.target);
        if (input) input.value = input.dataset.default;
      });
    });
  </script>
  <style>
    .settings-group { border: 1px solid #333; border-radius: 6px; margin: 12px 0; padding: 6px 12px 10px; }
    .settings-group legend { font-weight: bold; padding: 0 6px; }
    .setting-row { padding: 8px 0; border-top: 1px solid #222; }
    .setting-row:first-of-type { border-top: none; }
    .setting-row label { font-weight: 600; }
    .setting-desc { margin: 2px 0 6px; font-size: 0.85em; color: #8a8a99; }
    .setting-input { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .setting-input input { width: 140px; }
    .setting-default { font-size: 0.8em; color: #777; }
    .reset-btn { font-size: 0.8em; }
    .unit { color: #8a8a99; font-weight: normal; }
  </style>
</div>
```

- [ ] **Step 5: Run tests** — `npx vitest run tests/web-admin-settings.test.ts` PASS (all 3), then `npx vitest run` (full) + `npm run typecheck` green.
- [ ] **Step 6: Commit** — `git add src/web/routes/admin.ts src/web/views/admin-settings.ejs tests/web-admin-settings.test.ts && git commit -m "feat(admin): grouped, self-describing settings page with per-setting reset"`

- [ ] **Step 7 (controller, optional): visual check** — serve the app and view `/admin/settings` (after admin login) to confirm the grouped layout, descriptions, defaults, and reset button read well. Not required for merge (the route test covers rendering), but a quick look is nice since it's a UI page.

---

## Self-Review

- **Spec coverage:** metadata registry + groupedSettings (Task 1), grouped page + reset + route wiring (Task 2). The coverage test (Task 1) is the spec's durable guard. All spec §Testing items map to task tests.
- **Type consistency:** `groupedSettings` returns `SettingsGroup[]` consumed by the view as `groups`; `GroupedItem` fields (`key/label/description/unit/value/default/min/max/step`) match the EJS references; `SETTINGS_META` keys are exactly the `DEFAULT_SETTINGS` keys (enforced by test).
- **No placeholders:** all 22 metadata entries and the full EJS are inlined.
- **Non-breaking:** inputs keep `name="<key>"`; POST handler untouched, so saving still works (the unchanged "updates a knob" test proves it).
