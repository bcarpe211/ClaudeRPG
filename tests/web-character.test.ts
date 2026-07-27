import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';
import { purchase } from '../src/domain/shop';
import { seedSettings } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  app = createApp({ db, config: loadConfig({}) });
});

describe('character sheet', () => {
  it('GET /character shows the login form', async () => {
    const res = await request(app).get('/character');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="token"');
  });

  it('GET /character?token=... shows the sheet with stats and snippet', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    db.prepare('UPDATE players SET gold = 2000000 WHERE id = ?').run(p.id);
    purchase(db, p.id, 'cosmetic_wheel_t1', 1_500_000, 1001);
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toContain('Gandalf');
    expect(res.text).toContain('claude_rpg_token=');
    expect(res.text).toContain('class="character-avatar sprite-anim"');
    expect(res.text.match(/class="px frame-a"/g)).toHaveLength(1);
    expect(res.text.match(/class="px frame-b"/g)).toHaveLength(1);
    expect(res.text.match(/<canvas id="dye-preview"/g)).toHaveLength(1);
    expect(res.text).not.toContain('dye-active-label');
    const steel = res.text.indexOf('data-recipe="steel"');
    const bronze = res.text.indexOf('data-recipe="bronze"');
    const gold = res.text.indexOf('data-recipe="gold"');
    const restore = res.text.indexOf('data-recipe="none"');
    expect([steel, bronze, gold, restore]).toEqual([...([steel, bronze, gold, restore])].sort((a, b) => a - b));
    expect(res.text.match(/class="dye-fin" data-recipe=/g)).toHaveLength(4);
    expect(res.text).not.toContain('class="dye-fin dye-default"');
    expect(res.text).not.toContain('↺');
    expect(res.text).toContain('class="dye-fin-swatch dye-fin-default" aria-hidden="true"');
  });

  it('rejects an unknown token', async () => {
    const res = await request(app).get('/character').query({ token: 'nope' });
    expect(res.status).toBe(404);
  });

  it('renames via POST /character/rename', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app)
      .post('/character/rename')
      .type('form')
      .send({ token: p.auth_token, name: 'Gandalf the White' });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)?.name).toBe('Gandalf the White');
  });

  it('deletes via POST /character/delete', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const res = await request(app)
      .post('/character/delete')
      .type('form')
      .send({ token: p.auth_token });
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });

  it('returns 500 (not a crash) when a player has a corrupt class_key', async () => {
    const p = createPlayer(db, { name: 'Brokie', class_key: 'knight', gender: 'M' }, 1000);
    // Corrupt the class_key directly so classSpriteUrl() will throw inside the async handler.
    db.prepare('UPDATE players SET class_key = ? WHERE id = ?').run('not_a_class', p.id);
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(500);
  });
});
