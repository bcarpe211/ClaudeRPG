import type Database from 'better-sqlite3';
import type { Gender } from './classes';
import type { CosmeticChannelDefinition, CosmeticTier } from './cosmetic-entitlements';
import { channelsFor } from './cosmetic-entitlements';
import { getCosmetics } from './cosmetics';
import { getPlayerById } from './players';
import { nextCosmeticSku, skuPrice } from './shop';
import { cosmeticSkinUrlForPlayer } from './slotcosmetics';

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
  mastered: boolean;
}

/** Build the Bazaar from fresh database state, including the exact next permanent unlock. */
export function buildShopViewModel(
  db: Database.Database,
  playerId: number,
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

  return {
    currentTier,
    gold: player.gold,
    avatarA: cosmeticSkinUrlForPlayer(db, player, 'a'),
    avatarB: cosmeticSkinUrlForPlayer(db, player, 'b'),
    nextOffer,
    mastered: currentTier >= 3,
  };
}
