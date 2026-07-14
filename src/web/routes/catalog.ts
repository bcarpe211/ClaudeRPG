import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { buildCatalog } from '../catalog/build';
import { CREATURE_SHEET_NAMES } from '../catalog/spritenames';
import { MONSTERS } from '../../domain/bestiary';
import { CLASSES, spriteIndexFor } from '../../domain/classes';
import { TILE_MANIFEST } from '../../domain/tilemanifest';

function listPngs(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'));
  } catch {
    return [];
  }
}

export function registerCatalogRoutes(app: Express, { config }: AppDeps): void {
  if (!config.enableCatalog) return;
  const base = path.resolve(config.spritesDir);

  app.get(
    '/catalog',
    asyncHandler(async (_req, res) => {
      const classAvatars = CLASSES.flatMap((c) =>
        (['M', 'F'] as const).map((g) => ({
          name: `${c.name} ${g}`,
          index: spriteIndexFor(c.key, g),
        })),
      );
      const view = buildCatalog({
        creatureFiles: listPngs(path.join(base, 'creatures_24x24')),
        worldFiles: listPngs(path.join(base, 'world_24x24')),
        classSheetFiles: listPngs(path.join(base, 'classes_26x28')),
        creatureNames: CREATURE_SHEET_NAMES,
        monsters: MONSTERS,
        classAvatars,
        themes: TILE_MANIFEST,
      });
      res.send(await renderPage('catalog', { title: 'Sprite Catalog', frame: 'lite', view }));
    }),
  );
}
