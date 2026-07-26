import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { getClass, creatureSpriteFile, type Gender } from '../../domain/classes';
import { getPlayerById, getPlayerByToken } from '../../domain/players';
import { purchase } from '../../domain/shop';
import { buildShopViewModel } from '../../domain/shopview';
import {
  CLOTHING, spriteFileIndex, spriteId,
} from '../../domain/cosmetics';
import { recolorSprite, recolorSpriteSlots } from '../../domain/spritetint';
import { loadSlotmap, loadSlotmapFresh, SLOTS } from '../../domain/slots';
import { getEntitledSlotConfig, skinRenderHash } from '../../domain/slotcosmetics';

const ShopPurchaseInput = z.object({
  token: z.string().min(1),
  sku: z.string().min(1),
});

const PURCHASE_RESULTS = new Set([
  'success', 'insufficient_gold', 'stale', 'out_of_sequence', 'invalid',
]);

type PurchaseResultCode = 'success' | 'insufficient_gold' | 'stale' | 'out_of_sequence' | 'invalid';

function shopLocation(token: string, result: PurchaseResultCode): string {
  const query = new URLSearchParams({ token, result });
  return `/shop?${query.toString()}`;
}

export function registerShopRoutes(app: Express, { db, config, slotmapsDir }: AppDeps): void {
  const cacheDir = path.join(path.dirname(config.dbPath), 'tint-cache');

  app.get('/sprite/tint/:sprite/:frame/:hue.png', asyncHandler(async (req, res) => {
    const [classKey, gender] = String(req.params.sprite).split('_');
    const frame = req.params.frame === 'b' ? 'b' : 'a';
    const hue = Number(req.params.hue);
    if (!getClass(classKey) || (gender !== 'M' && gender !== 'F') || !CLOTHING[classKey]) {
      res.sendStatus(404); return;
    }
    if (!Number.isInteger(hue) || hue < 0 || hue > 359) { res.sendStatus(400); return; }

    const cacheFile = path.join(cacheDir, `${classKey}_${gender}_${frame}_${hue}.png`);
    res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable');
    if (fs.existsSync(cacheFile)) { res.sendFile(path.resolve(cacheFile)); return; }

    const srcFile = path.resolve(
      config.spritesDir, 'creatures_24x24',
      creatureSpriteFile(spriteFileIndex(classKey, gender as Gender, frame)),
    );
    const c = CLOTHING[classKey];
    const src = fs.readFileSync(srcFile);
    const slotIds = loadSlotmap(`${classKey}_${gender}`, frame);
    let out: Buffer;
    if (slotIds) {
      // slot-map render: color only the body slot (collisions isolated by the map)
      const bodyRule = c.op === 'colorize'
        ? { op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
        : { op: 'hue' as const, hue };
      out = recolorSpriteSlots(src, slotIds, new Map([[SLOTS.body, bodyRule]]));
    } else {
      // no slot-map (e.g. female) — fall back to the Phase-1 hex recolor
      const rule = c.op === 'colorize'
        ? { hexes: c.dominant, op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
        : { hexes: c.dominant, op: 'hue' as const, hue };
      out = recolorSprite(src, [rule]);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));

  // Per-slot skin: render a player's full slot config through the slot-map, cached by render hash.
  app.get('/sprite/skin/:playerId/:frame/:hash.png', asyncHandler(async (req, res) => {
    const playerId = Number(req.params.playerId);
    const frame = req.params.frame === 'b' ? 'b' : 'a';
    if (!Number.isInteger(playerId)) { res.sendStatus(400); return; }
    const player = getPlayerById(db, playerId);
    if (!player) { res.sendStatus(404); return; }

    const slotConfig = getEntitledSlotConfig(db, player);
    const sprite = spriteId(player.class_key, player.gender as Gender);
    const hash = skinRenderHash(sprite, slotConfig, slotmapsDir);
    if (req.params.hash !== hash) {
      res.redirect(302, `/sprite/skin/${playerId}/${frame}/${hash}.png`);
      return;
    }
    res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable');
    const cacheFile = path.join(cacheDir, `skin_${playerId}_${frame}_${hash}.png`);
    if (fs.existsSync(cacheFile)) { res.sendFile(path.resolve(cacheFile)); return; }

    const srcFile = path.resolve(
      config.spritesDir, 'creatures_24x24',
      creatureSpriteFile(spriteFileIndex(player.class_key, player.gender as Gender, frame)),
    );
    const src = fs.readFileSync(srcFile);
    const slotIds = loadSlotmapFresh(sprite, frame, slotmapsDir);
    const out = slotIds ? recolorSpriteSlots(src, slotIds, slotConfig) : src; // no slot-map (female) → plain
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));

  app.get('/shop', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const result = typeof req.query.result === 'string' && PURCHASE_RESULTS.has(req.query.result)
      ? req.query.result as PurchaseResultCode
      : undefined;
    const player = token ? getPlayerByToken(db, token) : undefined;
    const error = token && !player ? 'No character found for that token.' : undefined;
    const shop = player ? buildShopViewModel(db, player.id) : null;
    res.status(error ? 404 : 200).send(await renderPage('shop', {
      title: 'The Bazaar',
      frame: 'full',
      player,
      shop,
      error,
      purchaseResult: result,
      mimicUrl: `/sprites/creatures_24x24/${creatureSpriteFile(198)}`,
    }));
  }));

  app.post('/shop/cosmetics/purchase', (req, res) => {
    const parsed = ShopPurchaseInput.safeParse(req.body);
    if (!parsed.success) {
      res.redirect('/shop?result=invalid');
      return;
    }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) {
      res.redirect('/shop?result=invalid');
      return;
    }
    const result = purchase(db, player.id, parsed.data.sku, Date.now());
    const resultCode: PurchaseResultCode = result.ok
      ? 'success'
      : result.reason === 'insufficient_gold'
        ? 'insufficient_gold'
        : result.reason === 'already_owned'
          ? 'stale'
          : result.reason === 'out_of_sequence'
            ? 'out_of_sequence'
            : 'invalid';
    res.redirect(shopLocation(player.auth_token, resultCode));
  });
}
