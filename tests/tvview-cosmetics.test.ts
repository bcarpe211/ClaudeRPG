import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import {
  cosmeticSkinUrlForPlayer, setSlotRule, skinRenderHash, getEntitledSlotConfig, getSlotConfig,
} from '../src/domain/slotcosmetics';
import { SLOTS } from '../src/domain/slots';
import { spriteId } from '../src/domain/cosmetics';
import { buildTvState } from '../src/web/tvview';

describe('tv hero avatar honors cosmetics', () => {
  it('a legacy body hue renders via the per-slot skin URL', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 2000000, effective_tokens = 5 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    const hero = buildTvState(db, 100000).players.find((x) => x.id === p.id)!;
    expect(hero.avatarUrl).toBe(`/sprite/skin/${p.id}/a/${skinRenderHash(spriteId(p.class_key, p.gender), getSlotConfig(db, p.id))}.png`);
  });
  it('uses the per-slot skin URL when a slot rule is set', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET effective_tokens = 5, gold = 7000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 99);
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 200 }, 100);
    const hero = buildTvState(db, 100000).players.find((x) => x.id === p.id)!;
    expect(hero.avatarUrl).toBe(`/sprite/skin/${p.id}/a/${skinRenderHash(spriteId(p.class_key, p.gender), getEntitledSlotConfig(db, p))}.png`);
  });
  it('uses the plain class sprite at Tier 0 even when a raw rule exists', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET effective_tokens = 5 WHERE id = ?').run(p.id);
    setSlotRule(db, p.id, SLOTS.body, { op: 'hue', hue: 200 }, 100);

    expect(getSlotConfig(db, p.id).size).toBe(1);
    expect(getEntitledSlotConfig(db, p).size).toBe(0);
    expect(cosmeticSkinUrlForPlayer(db, p)).toBe('/sprites/creatures_24x24/oryx_16bit_fantasy_creatures_04.png');
    expect(buildTvState(db, 100000).players.find((x) => x.id === p.id)!.avatarUrl)
      .toBe(cosmeticSkinUrlForPlayer(db, p));
  });
});
