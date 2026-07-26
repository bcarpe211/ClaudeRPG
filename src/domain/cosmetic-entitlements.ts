import type { Gender } from './classes';
import { SLOTS } from './slots';

export type CosmeticTier = 1 | 2 | 3;

export interface CosmeticChannelDefinition {
  slot: number;
  label: string;
  requiredTier: CosmeticTier;
  genders: readonly Gender[];
}

const BOTH = ['M', 'F'] as const;
const FEMALE = ['F'] as const;

const c = (
  slot: number,
  label: string,
  requiredTier: CosmeticTier,
  genders: readonly Gender[] = BOTH,
): CosmeticChannelDefinition => ({ slot, label, requiredTier, genders });

export const COSMETIC_CHANNELS: Record<string, readonly CosmeticChannelDefinition[]> = {
  knight: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.belt, 'Belt', 2), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Plume', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Shield', 3)],
  thief: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.cape, 'Cape', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Feather', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Accessory', 3)],
  ranger: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.cape, 'Cloak', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Feather', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Quiver', 3)],
  wizard: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Cloak', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Gold trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.flair, 'Eyes', 3)],
  priest: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.belt, 'Belt', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.flair, 'Holy symbol', 3)],
  shaman: [c(SLOTS.headgear, 'Pelt', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.body, 'Clothing', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Face paint', 2), c(SLOTS.flair, 'Lips', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3)],
  berserker: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Helmet trim', 2), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.flair, 'Horns', 3)],
  swordsman: [c(SLOTS.body, 'Shirt', 1), c(SLOTS.headgear, 'Clothing', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.trim, 'Trim', 2), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Details', 2, FEMALE), c(SLOTS.weapon, 'Weapon', 3)],
  paladin: [c(SLOTS.body, 'Clothing', 1), c(SLOTS.headgear, 'Headgear', 1), c(SLOTS.skin, 'Skin', 1), c(SLOTS.cape, 'Cape', 2), c(SLOTS.hair, 'Hair', 2, FEMALE), c(SLOTS.boots, 'Boots', 2), c(SLOTS.facePaint, 'Lips', 2, FEMALE), c(SLOTS.flair, 'Plume', 2), c(SLOTS.weapon, 'Weapon', 3), c(SLOTS.shield, 'Shield', 3)],
};

export function channelsFor(classKey: string, gender: Gender): CosmeticChannelDefinition[] {
  return (COSMETIC_CHANNELS[classKey] ?? []).filter((channel) => channel.genders.includes(gender));
}

export function channelFor(
  classKey: string,
  gender: Gender,
  slot: number,
): CosmeticChannelDefinition | undefined {
  return channelsFor(classKey, gender).find((channel) => channel.slot === slot);
}

export function requiredTierFor(
  classKey: string,
  gender: Gender,
  slot: number,
): CosmeticTier | undefined {
  return channelFor(classKey, gender, slot)?.requiredTier;
}

export function entitledChannelsFor(
  classKey: string,
  gender: Gender,
  wheelTier: number,
): CosmeticChannelDefinition[] {
  return channelsFor(classKey, gender).filter((channel) => wheelTier >= channel.requiredTier);
}

export function lockedChannelsFor(
  classKey: string,
  gender: Gender,
  wheelTier: number,
): CosmeticChannelDefinition[] {
  return channelsFor(classKey, gender).filter((channel) => wheelTier < channel.requiredTier);
}

export function channelLabel(classKey: string, slot: number, gender: Gender = 'M'): string {
  return channelFor(classKey, gender, slot)?.label ?? `Slot ${slot}`;
}
