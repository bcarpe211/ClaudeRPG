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
  monsters: { index: number; category: string; boss: boolean }[]; // bestiary MONSTERS
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

// The 198 creature_key.doc names map 1:1, in reading order, to the 198 frame-A
// files (odd sheet rows: 1-18, 37-54, 73-90, ...). Every even row is that
// creature's animation frame (frame-A index + 18) and carries no separate doc
// name. Verified end-to-end: name 1 -> file 1 (Knight M), name 19 -> file 37
// (Bandit), name 198 -> file 378 (Cold Flame).
/** Doc-name for a frame-A creature file; null for frame-B (animation) files. */
export function nameForCreatureFile(index: number, names: string[]): string | null {
  if (!isFrameA(index)) return null;
  // 0-based ordinal of this file among the frame-A files, in reading order.
  const ordinal = Math.floor((index - 1) / (ROW * 2)) * ROW + ((index - 1) % ROW);
  return names[ordinal] ?? null;
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
        const m = input.monsters.find((mo) => mo.index === aIndex);
        if (m) {
          annotation.push(m.category);
          if (m.boss) annotation.push('boss');
        } else {
          annotation.push('unused');
        }
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
