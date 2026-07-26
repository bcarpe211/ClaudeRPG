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
  applySlotMutation,
  applySlotMutationBatch,
  cosmeticSkinUrlForPlayer,
  getEntitledSlotConfig,
  skinRenderHash,
} from '../../domain/slotcosmetics';
import { buildSetupSnippet } from '../../domain/snippet';
import { getCosmetics, spriteId } from '../../domain/cosmetics';
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
        avatarA: cosmeticSkinUrlForPlayer(db, player, 'a'),
        avatarB: cosmeticSkinUrlForPlayer(db, player, 'b'),
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

    const config = getEntitledSlotConfig(db, player);
    res.json({
      config: Object.fromEntries(config),
      hash: skinRenderHash(
        spriteId(player.class_key, player.gender as Gender),
        config,
        slotmapsDir,
      ),
    });
  });
}
