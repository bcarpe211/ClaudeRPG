import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/db';
import { seedSettings } from '../src/domain/settings';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import { buildTvState } from '../src/web/tvview';

describe('tv hero avatar honors cosmetics', () => {
  it('uses the tinted URL when a hue is set', () => {
    const db = openDb(':memory:'); seedSettings(db);
    const p = createPlayer(db, { name: 'A', class_key: 'wizard', gender: 'M' }, 1);
    db.prepare('UPDATE players SET gold = 2000000, effective_tokens = 5 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 100);
    setCosmeticHue(db, p.id, 'primary', 210, 200);
    const hero = buildTvState(db, 100000).players.find((x) => x.id === p.id)!;
    expect(hero.avatarUrl).toBe('/sprite/tint/wizard_M/a/210.png');
  });
});
