import type Database from 'better-sqlite3';
import { classSpriteUrl, type Gender } from './classes';
import {
  channelLabel,
  channelsFor,
  entitledChannelsFor,
  type CosmeticTier,
} from './cosmetic-entitlements';
import { getCosmetics, spriteId } from './cosmetics';
import { nextCosmeticSku, skuPrice } from './shop';
import { getEntitledSlotConfig } from './slotcosmetics';
import {
  loadSlotmap,
  presentSlots,
} from './slots';
import type { SlotRule } from './spritetint';

export { channelLabel } from './cosmetic-entitlements';

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

/** Presets available to the Wardrobe after the appropriate tier is unlocked. */
export const MATERIAL_PRESETS = {
  steel: { op: 'colorize', hue: 212, sat: 0.13, tone: 0 },
  bronze: { op: 'colorize', hue: 28, sat: 0.58, tone: -0.12 },
  gold: { op: 'colorize', hue: 46, sat: 0.75, tone: 0.10 },
} as const satisfies Record<string, SlotRule>;

/** Translate a picker action into the rule shape persisted by Phase 2B.1. */
export function dyeRule(recipe: string, hue: number | null, tone?: number): SlotRule | null {
  if (recipe === 'wheel') {
    return hue != null && Number.isInteger(hue) && hue >= 0 && hue <= 359
      ? { ...wheelRule(hue), tone: tone ?? 0 }
      : null;
  }
  const preset = (MATERIAL_PRESETS as Record<string, SlotRule>)[recipe];
  return preset ? { ...preset, tone: tone ?? preset.tone ?? 0 } : null;
}

export interface DyeChannel {
  slot: number;
  label: string;
  requiredTier: CosmeticTier;
}

export interface DyeTierGroup {
  tier: CosmeticTier;
  unlocked: boolean;
  channels: DyeChannel[];
}

export interface DyeNextOffer {
  tier: CosmeticTier;
  price: number;
}

export interface DyeViewModel {
  available: boolean;
  tier: number;
  groups: DyeTierGroup[];
  channels: DyeChannel[];
  slotmap: number[];
  base: string;
  config: Record<number, SlotRule>;
  presets: typeof MATERIAL_PRESETS;
  nextOffer: DyeNextOffer | null;
  wheelSat: number;
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
  const wheelTier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
  const presentSet = new Set(present);
  const definitions = channelsFor(player.class_key, gender)
    .filter((channel) => presentSet.has(channel.slot));
  const groups: DyeTierGroup[] = ([1, 2, 3] as const).map((tier) => ({
    tier,
    unlocked: wheelTier >= tier,
    channels: definitions
      .filter((channel) => channel.requiredTier === tier)
      .map(({ slot, label, requiredTier }) => ({ slot, label, requiredTier })),
  }));
  const channels = entitledChannelsFor(player.class_key, gender, wheelTier)
    .filter((channel) => presentSet.has(channel.slot))
    .map(({ slot, label, requiredTier }) => ({ slot, label, requiredTier }));
  const nextSku = nextCosmeticSku(wheelTier);
  const nextOffer = nextSku
    ? { tier: nextSku.grantTier, price: skuPrice(db, nextSku) }
    : null;
  const config = Object.fromEntries(getEntitledSlotConfig(db, player));

  return {
    available: ids !== null && present.length > 0,
    tier: wheelTier,
    groups,
    channels,
    slotmap: ids ? Array.from(ids) : [],
    base: classSpriteUrl(player.class_key, gender),
    config,
    presets: MATERIAL_PRESETS,
    nextOffer,
    wheelSat: WHEEL_SAT,
  };
}
