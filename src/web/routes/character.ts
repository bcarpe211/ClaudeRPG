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
import { getClass, type Gender } from '../../domain/classes';
import {
  clearSlot,
  cosmeticSkinUrl,
  getSlotConfig,
  setSlotRule,
} from '../../domain/slotcosmetics';
import { buildSetupSnippet } from '../../domain/snippet';
import { getCosmetics, spriteId } from '../../domain/cosmetics';
import { dyeRule, dyeViewModel } from '../../domain/dye';
import { purchase } from '../../domain/shop';
import { presentSlots } from '../../domain/slots';

const RenameInput = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(40),
});
const TokenInput = z.object({ token: z.string().min(1) });
const DyeSetInput = z.object({
  token: z.string().min(1),
  slot: z.coerce.number().int().min(0).max(11),
  finish: z.enum(['wheel', 'black', 'white', 'steel']),
  hue: z.coerce.number().int().min(0).max(359).optional(),
});
const DyeClearInput = z.object({
  token: z.string().min(1),
  slot: z.coerce.number().int().min(0).max(11),
});

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
        avatarUrl: cosmeticSkinUrl(player.id, player.class_key, player.gender as Gender, getSlotConfig(db, player.id), 'a'),
        dye: dyeViewModel(db, player),
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

  app.post('/character/dye/unlock', (req, res) => {
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
    const sprite = spriteId(player.class_key, player.gender as Gender);
    if (presentSlots(sprite).length === 0) {
      res.status(409).send('Dyes are not available for this sprite yet');
      return;
    }

    const result = purchase(
      db,
      player.id,
      'cosmetic_wheel_t1',
      Date.now(),
    );
    if (!result.ok && result.reason === 'insufficient_gold') {
      res.status(409).send('Not enough gold');
      return;
    }
    if (!result.ok && result.reason !== 'already_owned') {
      res.status(400).send('Unable to unlock the dye wheel');
      return;
    }
    res.redirect(`/character?token=${encodeURIComponent(player.auth_token)}`);
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
    const cosmetics = getCosmetics(db, player.id);
    if (!cosmetics || cosmetics.wheel_tier < 1) {
      res.sendStatus(403);
      return;
    }
    const sprite = spriteId(player.class_key, player.gender as Gender);
    if (!presentSlots(sprite).includes(parsed.data.slot)) {
      res.sendStatus(400);
      return;
    }
    const rule = dyeRule(parsed.data.finish, parsed.data.hue ?? null);
    if (!rule) {
      res.sendStatus(400);
      return;
    }

    setSlotRule(db, player.id, parsed.data.slot, rule, Date.now());
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
    const cosmetics = getCosmetics(db, player.id);
    if (!cosmetics || cosmetics.wheel_tier < 1) {
      res.sendStatus(403);
      return;
    }
    const sprite = spriteId(player.class_key, player.gender as Gender);
    if (!presentSlots(sprite).includes(parsed.data.slot)) {
      res.sendStatus(400);
      return;
    }

    clearSlot(db, player.id, parsed.data.slot, Date.now());
    res.sendStatus(204);
  });
}
