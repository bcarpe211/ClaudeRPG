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
import { getClass } from '../../domain/classes';
import {
  applySlotMutation,
  cosmeticSkinUrlForPlayer,
} from '../../domain/slotcosmetics';
import { buildSetupSnippet } from '../../domain/snippet';
import { getCosmetics } from '../../domain/cosmetics';
import { dyeRule, dyeViewModel } from '../../domain/dye';
import { channelFor } from '../../domain/cosmetic-entitlements';
import { MAX_RECOLOR_SLOT } from '../../domain/slots';

const RenameInput = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(40),
});
const TokenInput = z.object({ token: z.string().min(1) });
const DyeSetInput = z.object({
  token: z.string().min(1),
  slot: z.coerce.number().int().min(0).max(MAX_RECOLOR_SLOT),
  recipe: z.enum(['wheel', 'steel', 'bronze', 'gold']),
  hue: z.coerce.number().int().min(0).max(359).optional(),
  tone: z.coerce.number().finite().min(-1).max(1).optional(),
  session: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  revision: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const DyeClearInput = z.object({
  token: z.string().min(1),
  slot: z.coerce.number().int().min(0).max(MAX_RECOLOR_SLOT),
  session: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  revision: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export function registerCharacterRoutes(
  app: Express,
  { db, config, slotmapsDir }: AppDeps,
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
        avatarUrl: cosmeticSkinUrlForPlayer(db, player, 'a'),
        dye: dyeViewModel(db, player, slotmapsDir),
        connected: player.last_token_at != null,
        snippet: buildSetupSnippet({
          token: player.auth_token,
          endpoint: config.publicUrl,
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

  app.post('/character/dye/set', (req, res) => {
    const parsed = DyeSetInput.safeParse(req.body);
    if (!parsed.success) {
      res.sendStatus(400);
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.sendStatus(404);
      return;
    }
    const definition = channelFor(player.class_key, player.gender, parsed.data.slot);
    if (!definition) {
      res.sendStatus(400);
      return;
    }
    const tier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
    if (tier < definition.requiredTier) {
      res.sendStatus(403);
      return;
    }
    const rule = dyeRule(parsed.data.recipe, parsed.data.hue ?? null, parsed.data.tone);
    if (!rule) {
      res.sendStatus(400);
      return;
    }

    const result = applySlotMutation(
      db, player.id, parsed.data.slot, parsed.data.session, parsed.data.revision, rule, Date.now(),
    );
    if (result === 'stale') {
      res.status(409).send('Stale cosmetic mutation');
      return;
    }
    res.sendStatus(204);
  });

  app.post('/character/dye/clear', (req, res) => {
    const parsed = DyeClearInput.safeParse(req.body);
    if (!parsed.success) {
      res.sendStatus(400);
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.sendStatus(404);
      return;
    }
    const definition = channelFor(player.class_key, player.gender, parsed.data.slot);
    if (!definition) {
      res.sendStatus(400);
      return;
    }
    const tier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
    if (tier < definition.requiredTier) {
      res.sendStatus(403);
      return;
    }

    const result = applySlotMutation(
      db, player.id, parsed.data.slot, parsed.data.session, parsed.data.revision, null, Date.now(),
    );
    if (result === 'stale') {
      res.status(409).send('Stale cosmetic mutation');
      return;
    }
    res.sendStatus(204);
  });
}
