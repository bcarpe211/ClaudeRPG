import type Database from 'better-sqlite3';
import { classSpriteUrl, type Gender } from './classes';
import type { CosmeticChannelDefinition, CosmeticTier } from './cosmetic-entitlements';
import { channelsFor } from './cosmetic-entitlements';
import { getCosmetics, spriteId } from './cosmetics';
import { getPlayerById } from './players';
import { inventoryQuantity, remainingDailyStock } from './inventory';
import { nextOfficeMidnight, officeDayKey } from './office-time';
import { potionEffectSnapshot } from './potions';
import { nextCosmeticSku, skuPrice } from './shop';
import {
  consumableProduct,
  type ConsumableProduct,
  type PotionType,
} from './shop-products';
import { getSetting } from './settings';
import { cosmeticSkinUrlForPlayer, getEntitledSlotConfig } from './slotcosmetics';
import { loadSlotmap } from './slots';
import type { SlotRule } from './spritetint';

export interface ShopOffer {
  sku: string;
  tier: CosmeticTier;
  price: number;
  missingGold: number;
  channels: CosmeticChannelDefinition[];
  description: string;
}

export interface ConsumableOffer {
  sku: ConsumableProduct['id'];
  name: string;
  potionType: PotionType;
  tier: 1;
  unitPrice: number;
  durationMs: number;
  durationLabel: string;
  inventory: number;
  stockRemaining: number;
  maxQuantity: number;
  missingGoldForOne: number;
  iconClass: ConsumableProduct['iconClass'];
  effectCopy: string;
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
  consumables: ConsumableOffer[];
  nextRestockAt: number;
}

const DEFAULT_DAILY_STOCK = 3;

function configuredDailyStock(db: Database.Database): number {
  const raw = getSetting(db, 'potion_daily_stock_per_sku');
  if (raw === undefined) return DEFAULT_DAILY_STOCK;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : DEFAULT_DAILY_STOCK;
  } catch {
    return DEFAULT_DAILY_STOCK;
  }
}

function joinChannelLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function titleCaseLabel(label: string): string {
  return label.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function activeDurationLabel(durationMs: number): string {
  const units = [
    { milliseconds: 3_600_000, singular: 'hour', plural: 'hours' },
    { milliseconds: 60_000, singular: 'minute', plural: 'minutes' },
  ];
  for (const unit of units) {
    if (durationMs >= unit.milliseconds && durationMs % unit.milliseconds === 0) {
      const value = durationMs / unit.milliseconds;
      return `${value.toLocaleString('en-US')} active ${value === 1 ? unit.singular : unit.plural}`;
    }
  }
  const seconds = durationMs / 1_000;
  const value = seconds.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return `${value} active ${seconds === 1 ? 'second' : 'seconds'}`;
}

function effectCopyFor(db: Database.Database, product: ConsumableProduct): string {
  const snapshot = potionEffectSnapshot(db, product.potionType, product.durationMs);
  if (!snapshot) throw new RangeError(`${product.id} effect settings are invalid`);
  if (snapshot.kind === 'gold') {
    return `${snapshot.goldPerUnit.toLocaleString('en-US')}g per 1,000 effective tokens`;
  }
  const percent = Number(((snapshot.baseHitMultiplier - 1) * 100).toFixed(10));
  return `+${percent.toLocaleString('en-US', { maximumFractionDigits: 10 })}% personal base hit`;
}

/** Build the Bazaar from fresh database state, including the exact next permanent unlock. */
export function buildShopViewModel(
  db: Database.Database,
  playerId: number,
  slotmapsDir: string | undefined,
  spritesDir: string | undefined,
  now: number,
  timeZone: string,
): ShopViewModel | null {
  const player = getPlayerById(db, playerId);
  if (!player) return null;
  const currentTier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
  const sku = nextCosmeticSku(currentTier);
  const nextOffer = sku ? (() => {
    const price = skuPrice(db, sku);
    const channels = channelsFor(player.class_key, player.gender as Gender)
      .filter((channel) => channel.requiredTier === sku.grantTier);
    const channelList = joinChannelLabels(channels.map((channel) => titleCaseLabel(channel.label)));
    return {
      sku: sku.id,
      tier: sku.grantTier,
      price,
      missingGold: Math.max(0, price - player.gold),
      channels,
      description: `The merchant is offering a permanent upgrade to your dye ledger, which unlocks ${channelList} customizations.`,
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
  const dayKey = officeDayKey(now, timeZone);
  const dailyStock = configuredDailyStock(db);
  const consumables = (['potion_gold_t1', 'potion_damage_t1'] as const).map((skuId) => {
    const product = consumableProduct(db, skuId);
    if (!product) throw new Error(`missing consumable product: ${skuId}`);
    const stockRemaining = remainingDailyStock(
      db,
      player.id,
      product.id,
      dayKey,
      dailyStock,
    );
    return {
      sku: product.id,
      name: product.name,
      potionType: product.potionType,
      tier: product.tier,
      unitPrice: product.price,
      durationMs: product.durationMs,
      durationLabel: activeDurationLabel(product.durationMs),
      inventory: inventoryQuantity(db, player.id, product.id),
      stockRemaining,
      maxQuantity: Math.min(3, stockRemaining),
      missingGoldForOne: Math.max(0, product.price - player.gold),
      iconClass: product.iconClass,
      effectCopy: effectCopyFor(db, product),
    };
  });

  return {
    currentTier,
    gold: player.gold,
    avatarA: cosmeticSkinUrlForPlayer(db, player, 'a', { spritesDir, slotmapsDir }),
    avatarB: cosmeticSkinUrlForPlayer(db, player, 'b', { spritesDir, slotmapsDir }),
    nextOffer,
    preview,
    mastered: currentTier >= 3,
    consumables,
    nextRestockAt: nextOfficeMidnight(now, timeZone),
  };
}
