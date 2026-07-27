import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { SlotRule } from './spritetint';
import { SLOTS, slotmapFingerprint } from './slots';
import { getCosmetics, CLOTHING, spriteId } from './cosmetics';
import { entitledChannelsFor } from './cosmetic-entitlements';

interface Row {
  slot: number;
  op: string;
  hue: number | null;
  sat: number | null;
  lo: number | null;
  hi: number | null;
  tone: number | null;
}
interface SessionRow {
  session: number;
}
interface BatchReceiptRow {
  digest: string;
}
const clean = (r: Row): SlotRule => ({
  op: r.op as SlotRule['op'],
  ...(r.hue != null ? { hue: r.hue } : {}), ...(r.sat != null ? { sat: r.sat } : {}),
  ...(r.lo != null ? { lo: r.lo } : {}), ...(r.hi != null ? { hi: r.hi } : {}),
  ...(r.tone != null ? { tone: r.tone } : {}),
});

export function normalizeTone(tone: number | undefined): number {
  return tone == null ? 0 : tone;
}

function assertTone(tone: number | undefined): void {
  if (tone !== undefined && (!Number.isFinite(tone) || tone < -1 || tone > 1)) {
    throw new RangeError('Tone must be a finite number from -1 to 1');
  }
}

/** A player's full per-slot recolor config. Body falls back to the legacy player_cosmetics.primary_hue. */
export function getSlotConfig(db: Database.Database, playerId: number): Map<number, SlotRule> {
  const map = new Map<number, SlotRule>();
  for (const r of db.prepare(
    'SELECT slot, op, hue, sat, lo, hi, tone FROM player_slot_cosmetics WHERE player_id = ?',
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
  assertTone(rule.tone);
  db.prepare(
    `INSERT INTO player_slot_cosmetics (player_id, slot, op, hue, sat, lo, hi, updated_at, tone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, slot) DO UPDATE SET
       op = excluded.op, hue = excluded.hue, sat = excluded.sat,
       lo = excluded.lo, hi = excluded.hi, updated_at = excluded.updated_at,
       tone = excluded.tone`,
  ).run(
    playerId, slot, rule.op, rule.hue ?? null, rule.sat ?? null,
    rule.lo ?? null, rule.hi ?? null, now, rule.tone ?? null,
  );
}

export function clearSlot(
  db: Database.Database,
  playerId: number,
  slot: number,
  now: number,
): void {
  db.transaction(() => clearSlotRows(db, playerId, slot, now))();
}

function clearSlotRows(
  db: Database.Database,
  playerId: number,
  slot: number,
  now: number,
): void {
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
}

/**
 * Issue a contiguous, strictly increasing browser-session epoch for this
 * player. Contiguity lets the server reject every epoch above the latest one
 * without accidentally accepting a value skipped by a wall-clock jump.
 */
export function beginSlotMutationSession(
  db: Database.Database,
  playerId: number,
): { session: number; revisionSeed: number } {
  return db.transaction(() => {
    const row = db.prepare(
      'SELECT session FROM player_cosmetic_mutation_sessions WHERE player_id = ?',
    ).get(playerId) as SessionRow | undefined;
    const session = (row?.session ?? 0) + 1;
    db.prepare(
      `INSERT INTO player_cosmetic_mutation_sessions (player_id, session)
       VALUES (?, ?)
       ON CONFLICT(player_id) DO UPDATE SET session = excluded.session`,
    ).run(playerId, session);
    return { session, revisionSeed: 1 };
  })();
}

export type SlotMutationResult = 'applied' | 'duplicate' | 'stale';

/**
 * Atomically accept a browser mutation only when it is newer than the
 * player+slot tombstone. A newer issued session does not invalidate an older
 * page simply by loading; it wins only after it writes this slot. A clear keeps
 * its tombstone so delayed sets cannot recreate a defaulted slot. Direct domain
 * callers keep using setSlotRule/clearSlot.
 */
export function applySlotMutation(
  db: Database.Database,
  playerId: number,
  slot: number,
  session: number,
  revision: number,
  rule: SlotRule | null,
  now: number,
): SlotMutationResult {
  return db.transaction(() => {
    const issued = db.prepare(
      'SELECT session FROM player_cosmetic_mutation_sessions WHERE player_id = ?',
    ).get(playerId) as SessionRow | undefined;
    if (!issued || session > issued.session) return 'stale';
    const previous = db.prepare(
      `SELECT session, revision FROM player_slot_cosmetic_revisions
       WHERE player_id = ? AND slot = ?`,
    ).get(playerId, slot) as SessionRow & { revision: number } | undefined;
    if (previous) {
      if (session < previous.session
        || (session === previous.session && revision < previous.revision)) return 'stale';
      if (session === previous.session && revision === previous.revision) return 'duplicate';
    }
    db.prepare(
      `INSERT INTO player_slot_cosmetic_revisions (player_id, slot, session, revision)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id, slot) DO UPDATE SET
         session = excluded.session, revision = excluded.revision`,
    ).run(playerId, slot, session, revision);
    if (rule) setSlotRule(db, playerId, slot, rule, now);
    else clearSlotRows(db, playerId, slot, now);
    return 'applied';
  })();
}

export interface SlotMutationOperation {
  slot: number;
  rule: SlotRule | null;
}

export type SlotMutationBatchResult = 'applied' | 'duplicate' | 'stale';

function slotMutationBatchDigest(operations: readonly SlotMutationOperation[]): string {
  const canonical = [...operations]
    .sort((a, b) => a.slot - b.slot)
    .map(({ slot, rule }) => rule
      ? `${slot}:${rule.op}:${rule.hue ?? ''}:${rule.sat ?? ''}:${rule.lo ?? ''}:${rule.hi ?? ''}:${normalizeTone(rule.tone)}`
      : `${slot}:clear`)
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export function applySlotMutationBatch(
  db: Database.Database,
  playerId: number,
  session: number,
  revision: number,
  operations: readonly SlotMutationOperation[],
  now: number,
): SlotMutationBatchResult {
  if (operations.length === 0) {
    throw new RangeError('Slot mutation batch must not be empty');
  }
  const digest = slotMutationBatchDigest(operations);
  return db.transaction(() => {
    const issued = db.prepare(
      'SELECT session FROM player_cosmetic_mutation_sessions WHERE player_id = ?',
    ).get(playerId) as SessionRow | undefined;
    if (!issued || session > issued.session) return 'stale';

    const receipt = db.prepare(
      `SELECT digest FROM player_slot_cosmetic_batches
       WHERE player_id = ? AND session = ? AND revision = ?`,
    ).get(playerId, session, revision) as BatchReceiptRow | undefined;
    if (receipt) return receipt.digest === digest ? 'duplicate' : 'stale';

    const states = operations.map(({ slot }) => {
      const previous = db.prepare(
        `SELECT session, revision FROM player_slot_cosmetic_revisions
         WHERE player_id = ? AND slot = ?`,
      ).get(playerId, slot) as (SessionRow & { revision: number }) | undefined;
      if (!previous) return 'new' as const;
      if (session < previous.session
        || (session === previous.session && revision < previous.revision)) return 'stale' as const;
      if (session === previous.session && revision === previous.revision) return 'duplicate' as const;
      return 'new' as const;
    });
    if (states.includes('stale')) return 'stale';
    if (states.every((state) => state === 'duplicate')) return 'duplicate';
    if (states.some((state) => state === 'duplicate')) return 'stale';

    for (const { slot, rule } of operations) {
      db.prepare(
        `INSERT INTO player_slot_cosmetic_revisions (player_id, slot, session, revision)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(player_id, slot) DO UPDATE SET
           session = excluded.session, revision = excluded.revision`,
      ).run(playerId, slot, session, revision);
      if (rule) setSlotRule(db, playerId, slot, rule, now);
      else clearSlotRows(db, playerId, slot, now);
    }
    db.prepare(
      `INSERT INTO player_slot_cosmetic_batches (player_id, session, revision, digest)
       VALUES (?, ?, ?, ?)`,
    ).run(playerId, session, revision, digest);
    return 'applied';
  })();
}

import { classSpriteUrl, type Gender } from './classes';

export interface CosmeticPlayerRef {
  id: number;
  class_key: string;
  gender: string;
}

/** Return only the saved rules that the player's class, gender, and purchased tier can render. */
export function filterEntitledSlotConfig(
  config: Map<number, SlotRule>,
  classKey: string,
  gender: Gender,
  wheelTier: number,
): Map<number, SlotRule> {
  const allowed = new Set(
    entitledChannelsFor(classKey, gender, wheelTier).map((channel) => channel.slot),
  );
  return new Map([...config].filter(([slot]) => allowed.has(slot)));
}

/** Entitlement-filtered render config; raw stored rows remain available through getSlotConfig. */
export function getEntitledSlotConfig(
  db: Database.Database,
  player: CosmeticPlayerRef,
): Map<number, SlotRule> {
  const tier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
  return filterEntitledSlotConfig(
    getSlotConfig(db, player.id), player.class_key, player.gender as Gender, tier,
  );
}

function canonicalSlotConfig(config: Map<number, SlotRule>): string {
  return [...config.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, r]) =>
      `${slot}:${r.op}:${r.hue ?? ''}:${r.sat ?? ''}:${r.lo ?? ''}:${r.hi ?? ''}:${normalizeTone(r.tone)}`)
    .join('|');
}

/** Stable content hash of a skin's sprite identity, slot maps, and ordered rules. */
export function skinRenderHash(
  sprite: string,
  config: Map<number, SlotRule>,
  slotmapsDir?: string,
): string {
  return createHash('sha256')
    .update('clauderpg:skin:v3\0')
    .update(sprite)
    .update('\0')
    .update(slotmapFingerprint(sprite, slotmapsDir))
    .update('\0')
    .update(canonicalSlotConfig(config))
    .digest('hex')
    .slice(0, 16);
}

/** Sprite URL for a character: the hashed skin URL when they have any cosmetics, else the plain sprite. */
export function cosmeticSkinUrl(
  playerId: number, classKey: string, gender: Gender, config: Map<number, SlotRule>, frame: 'a' | 'b' = 'a',
): string {
  if (config.size === 0) return classSpriteUrl(classKey, gender, frame);
  const sprite = spriteId(classKey, gender);
  return `/sprite/skin/${playerId}/${frame}/${skinRenderHash(sprite, config)}.png`;
}

/** The only player-facing skin URL: derives its hash from the entitlement-filtered render config. */
export function cosmeticSkinUrlForPlayer(
  db: Database.Database,
  player: CosmeticPlayerRef,
  frame: 'a' | 'b' = 'a',
): string {
  return cosmeticSkinUrl(
    player.id,
    player.class_key,
    player.gender as Gender,
    getEntitledSlotConfig(db, player),
    frame,
  );
}
