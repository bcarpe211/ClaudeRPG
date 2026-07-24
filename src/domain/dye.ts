import type Database from 'better-sqlite3';
import { classSpriteUrl, type Gender } from './classes';
import { getCosmetics, spriteId } from './cosmetics';
import { getSetting } from './settings';
import { SKUS } from './shop';
import { getSlotConfig } from './slotcosmetics';
import {
  loadSlotmap,
  presentSlots,
  SLOT_LABELS,
  SLOTS,
} from './slots';
import type { SlotRule } from './spritetint';

/** Fixed saturation used by the hue wheel's shadow-preserving colorize operation. */
export const WHEEL_SAT = 0.6;

export function wheelRule(hue: number): SlotRule {
  return { op: 'colorize', hue, sat: WHEEL_SAT };
}

/** Named neutral and metal finishes shared by the server and embedded client config. */
export const FINISHES: Record<'black' | 'white' | 'steel', SlotRule> = {
  black: { op: 'value', lo: 0, hi: 0.32 },
  white: { op: 'value', lo: 0.74, hi: 1 },
  steel: { op: 'colorize', hue: 212, sat: 0.13 },
};

/** Translate a picker action into the rule shape persisted by Phase 2B.1. */
export function dyeRule(finish: string, hue: number | null): SlotRule | null {
  if (finish === 'wheel') {
    return hue != null && Number.isInteger(hue) && hue >= 0 && hue <= 359
      ? wheelRule(hue)
      : null;
  }
  return (FINISHES as Record<string, SlotRule>)[finish] ?? null;
}

export interface DyeChannel {
  slot: number;
  label: string;
}

export interface DyeViewModel {
  available: boolean;
  unlocked: boolean;
  price: number;
  channels: DyeChannel[];
  slotmap: number[];
  base: string;
  config: Record<number, SlotRule>;
  finishes: typeof FINISHES;
  wheelSat: number;
}

const FLAIR_LABELS: Record<string, string> = {
  thief: 'Feather',
  ranger: 'Fletching',
  wizard: 'Eyes',
  priest: 'Holy symbol',
  berserker: 'Horns',
  paladin: 'Wings',
};

function channelLabel(classKey: string, slot: number): string {
  if (slot === SLOTS.flair && FLAIR_LABELS[classKey]) {
    return FLAIR_LABELS[classKey];
  }
  return SLOT_LABELS[slot] ?? `Slot ${slot}`;
}

function wheelPrice(db: Database.Database): number {
  const sku = SKUS.cosmetic_wheel_t1;
  const configured = Number(getSetting(db, sku.priceSetting));
  return Number.isFinite(configured) ? configured : sku.priceDefault;
}

export function dyeViewModel(
  db: Database.Database,
  player: { id: number; class_key: string; gender: string },
  slotmapsDir?: string,
): DyeViewModel {
  const gender = player.gender as Gender;
  const sprite = spriteId(player.class_key, gender);
  const ids = loadSlotmap(sprite, 'a', slotmapsDir);
  const present = presentSlots(sprite, slotmapsDir);
  const cosmetics = getCosmetics(db, player.id);
  const config: Record<number, SlotRule> = {};
  for (const [slot, rule] of getSlotConfig(db, player.id)) {
    config[slot] = rule;
  }

  return {
    available: ids !== null && present.length > 0,
    unlocked: !!cosmetics && cosmetics.wheel_tier >= 1,
    price: wheelPrice(db),
    channels: present.map((slot) => ({
      slot,
      label: channelLabel(player.class_key, slot),
    })),
    slotmap: ids ? Array.from(ids) : [],
    base: classSpriteUrl(player.class_key, gender),
    config,
    finishes: FINISHES,
    wheelSat: WHEEL_SAT,
  };
}
