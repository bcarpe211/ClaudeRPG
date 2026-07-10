import type { Express } from 'express';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { SHEET } from '../../domain/tilesheet';
import { DUNGEONS, getDungeon } from '../../domain/floorgroups';
import { generateAutotiledDungeon } from '../../domain/dungeon2';

export function registerDungeonPreviewRoutes(app: Express, { config }: AppDeps): void {
  if (!config.enableDungeonPreview) return;
  app.get(
    '/dungeon-preview',
    asyncHandler(async (req, res) => {
      const q = typeof req.query.dungeon === 'string' ? req.query.dungeon : '';
      const one = getDungeon(q);
      const samples = one
        ? [1, 2, 3, 4, 5, 6].map((seed) =>
            generateAutotiledDungeon(one.name, seed, { width: 18, height: 13 }))
        : DUNGEONS.flatMap((d) =>
            [1, 2].map((seed) =>
              generateAutotiledDungeon(d.name, seed, { width: 18, height: 13 })));
      res.send(
        await renderPage('dungeon-preview', {
          title: 'Dungeon Preview',
          sheet: SHEET,
          samples,
        }),
      );
    }),
  );
}
