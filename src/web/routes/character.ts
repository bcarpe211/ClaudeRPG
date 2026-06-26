import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import {
  getPlayerByToken,
  renamePlayer,
  deletePlayer,
} from '../../domain/players';
import { getClass, classSpriteUrl, type Gender } from '../../domain/classes';
import { buildSetupSnippet } from '../../domain/snippet';

const RenameInput = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(40),
});
const TokenInput = z.object({ token: z.string().min(1) });

export function registerCharacterRoutes(
  app: Express,
  { db, config }: AppDeps,
): void {
  app.get('/character', asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.send(await renderPage('character-login', { title: 'Character Login' }));
      return;
    }
    const player = getPlayerByToken(db, token);
    if (!player) {
      res.status(404).send(
        await renderPage('character-login', {
          title: 'Character Login',
          error: 'No character found for that token.',
        }),
      );
      return;
    }
    res.send(
      await renderPage('character-sheet', {
        title: player.name,
        player,
        className: getClass(player.class_key)?.name ?? player.class_key,
        avatarUrl: classSpriteUrl(player.class_key, player.gender as Gender),
        connected: player.last_token_at != null,
        snippet: buildSetupSnippet({
          token: player.auth_token,
          host: config.otelHost,
          port: config.port,
        }),
      }),
    );
  }));

  app.post('/character/rename', (req, res) => {
    const parsed = RenameInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send('Invalid input');
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    renamePlayer(db, player.id, parsed.data.name);
    res.redirect(`/character?token=${encodeURIComponent(player.auth_token)}`);
  });

  app.post('/character/delete', (req, res) => {
    const parsed = TokenInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send('Invalid input');
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.status(404).send('Not found');
      return;
    }
    deletePlayer(db, player.id);
    res.redirect('/');
  });
}
