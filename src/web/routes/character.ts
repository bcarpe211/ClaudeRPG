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
import type { Gender } from '../../domain/classes';
import {
  applySlotMutation,
  applySlotMutationBatch,
  getEntitledSlotConfig,
  skinRenderHash,
} from '../../domain/slotcosmetics';
import { getCosmetics, spriteId } from '../../domain/cosmetics';
import { dyeRule } from '../../domain/dye';
import { channelFor } from '../../domain/cosmetic-entitlements';
import { MAX_RECOLOR_SLOT } from '../../domain/slots';
import { buildPlayerHubState, buildPlayerHubViewModel } from '../../domain/playerhub';
import { activatePotion } from '../../domain/potions';

const RenameInput = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(40),
});
const TokenInput = z.object({ token: z.string().min(1) });
const PotionActivationInput = z.object({
  token: z.string().min(1),
  sku: z.enum(['potion_gold_t1', 'potion_damage_t1']),
  request_id: z.string().uuid(),
});
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
const DyeBatchEnvelope = z.object({
  token: z.string().min(1),
  session: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  revision: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  changes: z.string().min(2).max(8192),
}).strict();
const DyeBatchChanges = z.array(z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    slot: z.number().int().min(0).max(MAX_RECOLOR_SLOT),
    recipe: z.enum(['wheel', 'steel', 'bronze', 'gold']),
    hue: z.number().int().min(0).max(359).optional(),
    tone: z.number().finite().min(-1).max(1).optional(),
  }).strict(),
  z.object({
    action: z.literal('clear'),
    slot: z.number().int().min(0).max(MAX_RECOLOR_SLOT),
  }).strict(),
])).min(1).max(MAX_RECOLOR_SLOT);

export function registerCharacterRoutes(
  app: Express,
  { db, config, slotmapsDir }: AppDeps,
): void {
  app.get('/character', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.send(await renderPage('character-login', { title: 'Raider Login' }));
      return;
    }
    const player = getPlayerByToken(db, token);
    if (!player) {
      res.status(404).send(
        await renderPage('character-login', {
          title: 'Raider Login',
          error: 'No Raider found for that Raider Key.',
        }),
      );
      return;
    }
    const now = Date.now();
    const hub = buildPlayerHubViewModel(
      db,
      player,
      now,
      config.officeTimeZone,
      { spritesDir: config.spritesDir, slotmapsDir, publicUrl: config.publicUrl },
    );
    res.send(await renderPage('character-sheet', {
      title: player.name,
      player,
      ...hub,
      styles: ['player-hub.css'],
    }));
  }));

  app.get('/character/state', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
      res.status(400).json({ ok: false, reason: 'invalid_input' });
      return;
    }
    const player = getPlayerByToken(db, token);
    if (!player) {
      res.status(404).json({ ok: false, reason: 'no_player' });
      return;
    }
    res.json(buildPlayerHubState(db, player, Date.now(), config.officeTimeZone));
  });

  app.post('/character/potions/activate', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const parsed = PotionActivationInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, reason: 'invalid_input' });
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.status(404).json({ ok: false, reason: 'no_player' });
      return;
    }
    const result = activatePotion(db, {
      playerId: player.id,
      skuId: parsed.data.sku,
      requestId: parsed.data.request_id,
      now: Date.now(),
      timeZone: config.officeTimeZone,
    });
    res.status(result.ok ? 200 : 409).json(result);
  });

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

  app.post('/character/dye/save', (req, res) => {
    const envelope = DyeBatchEnvelope.safeParse(req.body);
    if (!envelope.success) {
      res.sendStatus(400);
      return;
    }

    let changes: z.infer<typeof DyeBatchChanges>;
    try {
      changes = DyeBatchChanges.parse(JSON.parse(envelope.data.changes));
    } catch {
      res.sendStatus(400);
      return;
    }

    const slots = new Set(changes.map(({ slot }) => slot));
    if (slots.size !== changes.length) {
      res.sendStatus(400);
      return;
    }

    const player = getPlayerByToken(db, envelope.data.token);
    if (!player) {
      res.sendStatus(404);
      return;
    }

    const tier = getCosmetics(db, player.id)?.wheel_tier ?? 0;
    for (const change of changes) {
      const definition = channelFor(player.class_key, player.gender, change.slot);
      if (!definition || tier < definition.requiredTier) {
        res.sendStatus(403);
        return;
      }
    }

    const operations = [];
    for (const change of changes) {
      if (change.action === 'clear') {
        operations.push({ slot: change.slot, rule: null });
        continue;
      }
      const rule = dyeRule(change.recipe, change.hue ?? null, change.tone);
      if (!rule) {
        res.sendStatus(400);
        return;
      }
      operations.push({ slot: change.slot, rule });
    }

    const result = applySlotMutationBatch(
      db,
      player.id,
      envelope.data.session,
      envelope.data.revision,
      operations,
      Date.now(),
    );
    if (result === 'stale') {
      res.status(409).send('Stale cosmetic mutation');
      return;
    }

    const renderConfig = getEntitledSlotConfig(db, player);
    res.json({
      config: Object.fromEntries(renderConfig),
      hash: skinRenderHash(
        spriteId(player.class_key, player.gender as Gender),
        renderConfig,
        slotmapsDir,
        config.spritesDir,
      ),
    });
  });
}
