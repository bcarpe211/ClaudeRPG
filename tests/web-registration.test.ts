import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { listPlayers } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, config: loadConfig({}) });
});

describe('registration', () => {
  it('GET / shows the form with all 9 classes', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Paladin');
    expect(res.text).toContain('name="class_key"');
  });

  it('POST /register creates a player and shows the token + snippet', async () => {
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ name: 'Sir Reginald', class_key: 'knight', gender: 'M' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('claude_rpg_token=');
    const players = listPlayers(db);
    expect(players.length).toBe(1);
    expect(players[0].name).toBe('Sir Reginald');
  });

  it('POST /register rejects bad input', async () => {
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ name: '', class_key: 'dragon', gender: 'X' });
    expect(res.status).toBe(400);
    expect(listPlayers(db).length).toBe(0);
  });
});
