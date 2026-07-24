import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { getClass, creatureSpriteFile, type Gender } from '../../domain/classes';
import { spriteFileIndex } from '../../domain/cosmetics';
import {
  buildCosmeticsReviewRoster,
  renderCosmeticsReviewSprite,
  type ReviewMode,
} from '../../domain/cosmeticsreview';
import {
  PICKER_ORDER,
  readSlotmap,
  SLOT_LABELS,
  slotmapFile,
  SLOTS,
} from '../../domain/slots';

function optionalQueryInteger(max: number) {
  return z.preprocess(
    (value) => (
      typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : value
    ),
    z.number().int().min(0).max(max).optional(),
  );
}

const ReviewQuery = z.object({
  mode: z.enum([
    'original',
    'slots',
    'focus',
    'hue',
    'black',
    'white',
    'steel',
  ]).default('original'),
  slot: optionalQueryInteger(11),
  hue: optionalQueryInteger(359),
});

const SLOT_MODES = new Set<ReviewMode>([
  'focus',
  'hue',
  'black',
  'white',
  'steel',
]);

function readFileOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) return null;
    throw error;
  }
}

export function registerCosmeticsReviewRoutes(
  app: Express,
  { config, slotmapsDir }: AppDeps,
): void {
  if (!config.enableCosmeticsReview) return;

  app.get(
    '/cosmetics-review',
    asyncHandler(async (_req, res) => {
      res.send(await renderPage('cosmetics-review', {
        title: 'Cosmetics Review',
        frame: 'lite',
        styles: ['cosmetics-review.css'],
        roster: buildCosmeticsReviewRoster(slotmapsDir),
        slots: PICKER_ORDER.map((slot) => ({
          slot,
          label: SLOT_LABELS[slot],
        })),
      }));
    }),
  );

  app.get(
    '/cosmetics-review/render/:sprite/:frame.png',
    asyncHandler(async (req, res) => {
      const spriteMatch = /^(.*)_(M|F)$/.exec(String(req.params.sprite));
      if (!spriteMatch) {
        res.sendStatus(404);
        return;
      }
      const [, classKey, genderValue] = spriteMatch;
      const classDef = getClass(classKey);
      if (!classDef) {
        res.sendStatus(404);
        return;
      }

      const frameValue = String(req.params.frame);
      if (frameValue !== 'a' && frameValue !== 'b') {
        res.sendStatus(404);
        return;
      }

      const query = ReviewQuery.safeParse(req.query);
      if (!query.success) {
        res.sendStatus(400);
        return;
      }
      const { mode, slot, hue } = query.data;
      if (
        (SLOT_MODES.has(mode) && (slot === undefined || slot === SLOTS.outline))
        || (mode === 'hue' && hue === undefined)
      ) {
        res.sendStatus(400);
        return;
      }

      const gender = genderValue as Gender;
      const sourceFile = path.resolve(
        config.spritesDir,
        'creatures_24x24',
        creatureSpriteFile(spriteFileIndex(classKey, gender, frameValue)),
      );
      const source = readFileOrNull(sourceFile);
      const mapBytes = readFileOrNull(
        slotmapFile(`${classKey}_${gender}`, frameValue, slotmapsDir),
      );
      if (!source || !mapBytes) {
        res.sendStatus(404);
        return;
      }

      const output = renderCosmeticsReviewSprite({
        source,
        slotIds: readSlotmap(mapBytes),
        mode,
        slot,
        hue,
      });
      res.type('png').set('Cache-Control', 'no-store').send(output);
    }),
  );
}
