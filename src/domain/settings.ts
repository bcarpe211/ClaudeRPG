import type Database from 'better-sqlite3';

// All game knobs (consumed by later plans). Values are strings; callers parse.
export const DEFAULT_SETTINGS: Record<string, string> = {
  base_xp: '50000',            // tokens for level 1 -> 2
  xp_growth: '1.5',            // geometric growth per level
  level_mult_slope: '0.10',    // damage multiplier slope per level
  base_hit: '100',             // base damage per swing at modifier 1.0, level 1
  attack_interval_ms: '4000',  // base swing interval
  attack_jitter_ms: '1500',    // +/- jitter on swing interval
  token_modifier_k: '20000',   // recent tokens that add +1.0 to modifier
  recent_window_minutes: '10', // rolling window for tokenModifier
  target_battle_minutes: '30', // target active-time battle length
  boss_hp_mult: '3',           // boss HP multiplier
  gold_factor: '0.01',         // gold = maxHP * dungeonLevel * gold_factor
  cache_read_weight: '0',      // weight applied to cacheRead tokens
  popup_duration_s: '120',     // defeat popup on-screen seconds
  pause_after_minutes: '15',   // office-wide inactivity before pause
};

export function seedSettings(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  });
  tx();
}

export function getSetting(
  db: Database.Database,
  key: string,
): string | undefined {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getAllSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
