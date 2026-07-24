import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import type { AppDeps } from '../app';
import { renderPage } from '../app';
import { asyncHandler } from '../async';
import { getClass, creatureSpriteFile, type Gender } from '../../domain/classes';
import { getPlayerById } from '../../domain/players';
import {
  CLOTHING, spriteFileIndex, spriteId,
} from '../../domain/cosmetics';
import { recolorSprite, recolorSpriteSlots } from '../../domain/spritetint';
import { loadSlotmap, SLOTS } from '../../domain/slots';
import { getSlotConfig, slotConfigHash } from '../../domain/slotcosmetics';

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

  // Per-slot skin: render a player's full slot config through the slot-map, cached by config hash.
  app.get('/sprite/skin/:playerId/:frame/:hash.png', asyncHandler(async (req, res) => {
    const playerId = Number(req.params.playerId);
    const frame = req.params.frame === 'b' ? 'b' : 'a';
    if (!Number.isInteger(playerId)) { res.sendStatus(400); return; }
    const player = getPlayerById(db, playerId);
    if (!player) { res.sendStatus(404); return; }

    const slotConfig = getSlotConfig(db, playerId);
    const hash = slotConfigHash(slotConfig);
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
    const slotIds = loadSlotmap(spriteId(player.class_key, player.gender as Gender), frame);
    const out = slotIds ? recolorSpriteSlots(src, slotIds, slotConfig) : src; // no slot-map (female) → plain
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));

  app.get('/shop', asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    res.send(await renderPage('shop', {
      title: 'The Bazaar',
      frame: 'full',
      token,
      mimicUrl: `/sprites/creatures_24x24/${creatureSpriteFile(198)}`,
    }));
  }));
}
