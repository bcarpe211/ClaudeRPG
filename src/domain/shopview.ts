import type Database from 'better-sqlite3';
import { classSpriteUrl, type Gender } from './classes';
import type { CosmeticChannelDefinition, CosmeticTier } from './cosmetic-entitlements';
import { channelsFor } from './cosmetic-entitlements';
import { getCosmetics, spriteId } from './cosmetics';
import { getPlayerById } from './players';
import { nextCosmeticSku, skuPrice } from './shop';
import { cosmeticSkinUrlForPlayer, getEntitledSlotConfig } from './slotcosmetics';
import { loadSlotmap } from './slots';
import type { SlotRule } from './spritetint';

export interface ShopOffer {
  sku: string;
  tier: CosmeticTier;
  price: number;
  missingGold: number;
  channels: CosmeticChannelDefinition[];
}

export interface ShopViewModel {
  currentTier: number;
  gold: number;
  avatarA: string;
  avatarB: string;
  nextOffer: ShopOffer | null;
  preview: {
    frames: {
      a: { base: string; slotmap: number[] };
      b: { base: string; slotmap: number[] };
    };
    config: Record<number, SlotRule>;
    demoSlots: number[];
  } | null;
  mastered: boolean;
}

/** Build the Bazaar from fresh database state, including the exact next permanent unlock. */
export function buildShopViewModel(
  db: Database.Database,
  playerId: number,
  slotmapsDir?: string,
): ShopViewModel | null {
  const player = getPlayerById(db, playerId);
  if (!player) return null;
  const currentTier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
  const sku = nextCosmeticSku(currentTier);
  const nextOffer = sku ? (() => {
    const price = skuPrice(db, sku);
    return {
      sku: sku.id,
      tier: sku.grantTier,
      price,
      missingGold: Math.max(0, price - player.gold),
      channels: channelsFor(player.class_key, player.gender as Gender)
        .filter((channel) => channel.requiredTier === sku.grantTier),
    };
  })() : null;
  const gender = player.gender as Gender;
  const sprite = spriteId(player.class_key, gender);
  const frameAIds = loadSlotmap(sprite, 'a', slotmapsDir);
  const frameBIds = loadSlotmap(sprite, 'b', slotmapsDir);
  const presentSlots = new Set<number>();
  for (const slotIds of [frameAIds, frameBIds]) {
    if (!slotIds) continue;
    for (const slot of slotIds) {
      if (slot !== 0) presentSlots.add(slot);
    }
  }
  const preview = nextOffer ? {
    frames: {
      a: {
        base: classSpriteUrl(player.class_key, gender, 'a'),
        slotmap: frameAIds ? Array.from(frameAIds) : [],
      },
      b: {
        base: classSpriteUrl(player.class_key, gender, 'b'),
        slotmap: frameBIds ? Array.from(frameBIds) : [],
      },
    },
    config: Object.fromEntries(getEntitledSlotConfig(db, player)),
    demoSlots: nextOffer.channels
      .filter((channel) => presentSlots.has(channel.slot))
      .map((channel) => channel.slot),
  } : null;

  return {
    currentTier,
    gold: player.gold,
    avatarA: cosmeticSkinUrlForPlayer(db, player, 'a'),
    avatarB: cosmeticSkinUrlForPlayer(db, player, 'b'),
    nextOffer,
    preview,
    mastered: currentTier >= 3,
  };
}
