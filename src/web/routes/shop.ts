import path from 'node:path';
import fs from 'node:fs';
import type { Express } from 'express';
import type { AppDeps } from '../app';
import { asyncHandler } from '../async';
import { getClass, creatureSpriteFile, type Gender } from '../../domain/classes';
import { CLOTHING, spriteFileIndex } from '../../domain/cosmetics';
import { recolorSprite } from '../../domain/spritetint';

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
    const out = recolorSprite(fs.readFileSync(srcFile), CLOTHING[classKey].dominant, hue);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, out);
    res.send(out);
  }));
}
