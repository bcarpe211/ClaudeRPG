import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { SlotRule } from './spritetint';
import { SLOTS, slotmapFingerprint } from './slots';
import { getCosmetics, CLOTHING, spriteId } from './cosmetics';

interface Row { slot: number; op: string; hue: number | null; sat: number | null; lo: number | null; hi: number | null }
const clean = (r: Row): SlotRule => ({
  op: r.op as SlotRule['op'],
  ...(r.hue != null ? { hue: r.hue } : {}), ...(r.sat != null ? { sat: r.sat } : {}),
  ...(r.lo != null ? { lo: r.lo } : {}), ...(r.hi != null ? { hi: r.hi } : {}),
});

/** A player's full per-slot recolor config. Body falls back to the legacy player_cosmetics.primary_hue. */
export function getSlotConfig(db: Database.Database, playerId: number): Map<number, SlotRule> {
  const map = new Map<number, SlotRule>();
  for (const r of db.prepare(
    'SELECT slot, op, hue, sat, lo, hi FROM player_slot_cosmetics WHERE player_id = ?',
  ).all(playerId) as Row[]) map.set(r.slot, clean(r));

  if (!map.has(SLOTS.body)) {
    const p = db.prepare('SELECT class_key FROM players WHERE id = ?').get(playerId) as { class_key: string } | undefined;
    const cos = getCosmetics(db, playerId);
    if (p && cos && cos.primary_hue != null) {
      const c = CLOTHING[p.class_key];
      map.set(SLOTS.body, c?.op === 'colorize'
        ? { op: 'colorize', hue: cos.primary_hue, sat: c.sat ?? 0.6 }
        : { op: 'hue', hue: cos.primary_hue });
    }
  }
  return map;
}

export function setSlotRule(db: Database.Database, playerId: number, slot: number, rule: SlotRule, now: number): void {
  db.prepare(
    `INSERT INTO player_slot_cosmetics (player_id, slot, op, hue, sat, lo, hi, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, slot) DO UPDATE SET
       op = excluded.op, hue = excluded.hue, sat = excluded.sat,
       lo = excluded.lo, hi = excluded.hi, updated_at = excluded.updated_at`,
  ).run(playerId, slot, rule.op, rule.hue ?? null, rule.sat ?? null, rule.lo ?? null, rule.hi ?? null, now);
}

export function clearSlot(
  db: Database.Database,
  playerId: number,
  slot: number,
  now: number,
): void {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM player_slot_cosmetics WHERE player_id = ? AND slot = ?',
    ).run(playerId, slot);
    if (slot === SLOTS.body) {
      db.prepare(
        `UPDATE player_cosmetics
         SET primary_hue = NULL, updated_at = ?
         WHERE player_id = ?`,
      ).run(now, playerId);
    }
  })();
}

import { classSpriteUrl, type Gender } from './classes';

function canonicalSlotConfig(config: Map<number, SlotRule>): string {
  return [...config.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, r]) =>
      `${slot}:${r.op}:${r.hue ?? ''}:${r.sat ?? ''}:${r.lo ?? ''}:${r.hi ?? ''}`)
    .join('|');
}

/** Stable content hash of a skin's sprite identity, slot maps, and ordered rules. */
export function skinRenderHash(
  sprite: string,
  config: Map<number, SlotRule>,
): string {
  return createHash('sha256')
    .update('clauderpg:skin:v2\0')
    .update(sprite)
    .update('\0')
    .update(slotmapFingerprint(sprite))
    .update('\0')
    .update(canonicalSlotConfig(config))
    .digest('hex')
    .slice(0, 16);
}

/** Sprite URL for a character: the hashed skin URL when they have any cosmetics, else the plain sprite. */
export function cosmeticSkinUrl(
  playerId: number, classKey: string, gender: Gender, config: Map<number, SlotRule>, frame: 'a' | 'b' = 'a',
): string {
  if (config.size === 0) return classSpriteUrl(classKey, gender);
  const sprite = spriteId(classKey, gender);
  return `/sprite/skin/${playerId}/${frame}/${skinRenderHash(sprite, config)}.png`;
}
