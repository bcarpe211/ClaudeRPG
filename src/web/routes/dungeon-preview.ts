import type { Express } from 'express';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { SHEET, SKINS } from '../../domain/tilesheet';
import { generateAutotiledDungeon } from '../../domain/dungeon2';

export function registerDungeonPreviewRoutes(app: Express, { config }: AppDeps): void {
  if (!config.enableDungeonPreview) return;
  app.get(
    '/dungeon-preview',
    asyncHandler(async (_req, res) => {
      const seeds = [1, 2, 3];
      const samples = SKINS.flatMap((s) =>
        seeds.map((seed) => generateAutotiledDungeon(s.name, seed, { width: 18, height: 13 })),
      );
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
