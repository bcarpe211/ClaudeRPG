import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { createPlayer, getPlayerById } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
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
    const res = await request(app).get('/character').query({ token: p.auth_token });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gandalf');
    expect(res.text).toContain('claude_rpg_token=');
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
});
