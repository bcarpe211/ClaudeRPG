import type { ThemeTiles } from '../../domain/tilemanifest';

export interface SpriteCell {
  index: number;
  file: string;
  name: string | null;
  annotation: string[];
}

export interface CatalogView {
  creatures: SpriteCell[];
  worldTiles: SpriteCell[];
  classSheet: SpriteCell[];
  counts: { creatures: number; worldTiles: number; classSheet: number };
}

export interface ClassAvatar {
  name: string; // e.g. "Knight M"
  index: number; // creatures_24x24 file index
}

export interface CatalogInput {
  creatureFiles: string[];
  worldFiles: string[];
  classSheetFiles: string[];
  creatureNames: string[]; // CREATURE_SHEET_NAMES, aligned [i] -> file index i+1
  tiers: number[][]; // MONSTER_TIERS
  bosses: number[]; // BOSSES
  classAvatars: ClassAvatar[];
  themes: Record<string, ThemeTiles>;
}

/** Parse the trailing integer from an oryx sprite filename. */
export function spriteIndex(file: string): number {
  const m = file.match(/_(\d+)\.png$/i);
  return m ? parseInt(m[1], 10) : NaN;
}

const byIndex = (a: SpriteCell, b: SpriteCell): number => a.index - b.index;

export function buildCatalog(input: CatalogInput): CatalogView {
  const creatures = input.creatureFiles
    .map((file): SpriteCell => {
      const index = spriteIndex(file);
      const avatar = input.classAvatars.find((a) => a.index === index);
      const annotation: string[] = [];
      if (avatar) {
        annotation.push(`class: ${avatar.name}`);
      } else {
        input.tiers.forEach((tier, t) => {
          if (tier.includes(index)) annotation.push(`tier ${t + 1}`);
        });
        if (input.bosses.includes(index)) annotation.push('boss');
        if (annotation.length === 0) annotation.push('unused');
      }
      return { index, file, name: input.creatureNames[index - 1] ?? null, annotation };
    })
    .sort(byIndex);

  const worldTiles = input.worldFiles
    .map((file): SpriteCell => {
      const index = spriteIndex(file);
      const annotation: string[] = [];
      for (const [theme, t] of Object.entries(input.themes)) {
        if (file === t.wall) annotation.push(`${theme}.wall`);
        if (t.wallVariants?.includes(file)) annotation.push(`${theme}.wallVariant`);
        if (file === t.floor) annotation.push(`${theme}.floor`);
        if (t.floorVariants.includes(file)) annotation.push(`${theme}.floorVariant`);
        if (file === t.door) annotation.push(`${theme}.door`);
        if (t.decor.includes(file)) annotation.push(`${theme}.decor`);
      }
      if (annotation.length === 0) annotation.push('unused');
      return { index, file, name: null, annotation };
    })
    .sort(byIndex);

  const classSheet = input.classSheetFiles
    .map((file): SpriteCell => ({
      index: spriteIndex(file),
      file,
      name: null,
      annotation: ['unused — candidate class art (#2)'],
    }))
    .sort(byIndex);

  return {
    creatures,
    worldTiles,
    classSheet,
    counts: {
      creatures: creatures.length,
      worldTiles: worldTiles.length,
      classSheet: classSheet.length,
    },
  };
}
