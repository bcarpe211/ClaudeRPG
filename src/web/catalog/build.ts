import type { ThemeTiles } from '../../domain/tilemanifest';

export interface SpriteCell {
  index: number;
  file: string;
  name: string | null;
  annotation: string[];
}

export interface CatalogView {
  creaturePairs: CreaturePair[];
  worldTiles: SpriteCell[];
  classSheet: SpriteCell[];
  counts: { creaturePairs: number; worldTiles: number; classSheet: number };
}

export interface CreaturePair {
  aIndex: number;
  aFile: string;
  aName: string | null;
  bIndex: number;
  bFile: string | null;
  bName: string | null;
  annotation: string[];
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

// creatures_24x24 is a 22x18 sheet of animation A/B pairs. Frame A = odd rows;
// animation partner is +18. Duplicated in anim.js for the browser (no bundler).
const ROW = 18;

function isFrameA(index: number): boolean {
  return Math.floor((index - 1) / ROW) % 2 === 0;
}

/** Doc-name for a creature file under the verified "Model B" mapping:
 *  1..18 -> the 18 class names; 37..216 -> doc name shifted past the 18 class
 *  B-frames; files 19..36 (class B-frames) and 217+ are unnamed. */
export function nameForCreatureFile(index: number, names: string[]): string | null {
  if (index >= 1 && index <= 18) return names[index - 1] ?? null;
  if (index >= 37 && index <= 216) return names[index - 19] ?? null;
  return null;
}

export function buildCatalog(input: CatalogInput): CatalogView {
  const fileByIndex = new Map<number, string>();
  for (const file of input.creatureFiles) fileByIndex.set(spriteIndex(file), file);

  const creaturePairs: CreaturePair[] = input.creatureFiles
    .filter((file) => isFrameA(spriteIndex(file)))
    .map((file): CreaturePair => {
      const aIndex = spriteIndex(file);
      const bIndex = aIndex + ROW;
      const avatar = input.classAvatars.find((a) => a.index === aIndex);
      const annotation: string[] = [];
      if (avatar) {
        annotation.push(`class: ${avatar.name}`);
      } else {
        input.tiers.forEach((tier, t) => {
          if (tier.includes(aIndex)) annotation.push(`tier ${t + 1}`);
        });
        if (input.bosses.includes(aIndex)) annotation.push('boss');
        if (annotation.length === 0) annotation.push('unused');
      }
      return {
        aIndex,
        aFile: file,
        aName: nameForCreatureFile(aIndex, input.creatureNames),
        bIndex,
        bFile: fileByIndex.get(bIndex) ?? null,
        bName: nameForCreatureFile(bIndex, input.creatureNames),
        annotation,
      };
    })
    .sort((a, b) => a.aIndex - b.aIndex);

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
    creaturePairs,
    worldTiles,
    classSheet,
    counts: {
      creaturePairs: creaturePairs.length,
      worldTiles: worldTiles.length,
      classSheet: classSheet.length,
    },
  };
}
