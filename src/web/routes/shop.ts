import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { getClass, classSpriteUrl, creatureSpriteFile, type Gender } from '../../domain/classes';
import { getPlayerByToken } from '../../domain/players';
import {
  CLOTHING, spriteFileIndex, getCosmetics, cosmeticSpriteUrl, spriteId,
} from '../../domain/cosmetics';
import { recolorSprite } from '../../domain/spritetint';
import { purchase, setCosmeticHue, SKUS } from '../../domain/shop';
import { getSetting } from '../../domain/settings';

export function registerShopRoutes(app: Express, { db, config }: AppDeps): void {
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
    const rule = c.op === 'colorize'
      ? { hexes: c.dominant, op: 'colorize' as const, hue, sat: c.sat ?? 0.6 }
      : { hexes: c.dominant, op: 'hue' as const, hue };
    const out = recolorSprite(fs.readFileSync(srcFile), [rule]);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));

  const priceOf = () => Number(getSetting(db, SKUS.cosmetic_wheel_t1.priceSetting) ?? SKUS.cosmetic_wheel_t1.priceDefault);

  app.get('/shop', asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const player = token ? getPlayerByToken(db, token) : undefined;
    if (!player) { res.send(await renderPage('character-login', { title: 'Character Login' })); return; }
    const cos = getCosmetics(db, player.id);
    res.send(await renderPage('shop', {
      title: 'Shop', frame: 'full',
      token, player, price: priceOf(),
      unlocked: !!cos && cos.wheel_tier >= 1,
      currentHue: cos?.primary_hue ?? null,
      spriteId: spriteId(player.class_key, player.gender as Gender),
      baseSpriteUrl: classSpriteUrl(player.class_key, player.gender as Gender),
      previewUrl: cosmeticSpriteUrl(player.class_key, player.gender as Gender, cos, 'a'),
      clothing: CLOTHING[player.class_key]?.dominant ?? [],
    }));
  }));

  const UnlockInput = z.object({ token: z.string().min(1) });
  app.post('/shop/unlock', (req, res) => {
    const parsed = UnlockInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).send('Invalid input'); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.status(404).send('No character'); return; }
    purchase(db, player.id, 'cosmetic_wheel_t1', Date.now());
    res.redirect(`/shop?token=${encodeURIComponent(parsed.data.token)}`);
  });

  const ColorInput = z.object({ token: z.string().min(1), hue: z.coerce.number().int().min(0).max(359) });
  app.post('/shop/color', (req, res) => {
    const parsed = ColorInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).send('Invalid input'); return; }
    const player = getPlayerByToken(db, parsed.data.token);
    if (!player) { res.status(404).send('No character'); return; }
    setCosmeticHue(db, player.id, 'primary', parsed.data.hue, Date.now());
    res.redirect(`/shop?token=${encodeURIComponent(parsed.data.token)}`);
  });
}
