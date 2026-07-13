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
  it('GET / is the landing page (pitch, Claude-Code-only note, links to register + tv)', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Your code has');            // hero pitch
    expect(res.text).toContain('Claude Code only');          // the scope callout
    expect(res.text).toContain('does <b>not</b> count Claude <b>API</b>');
    expect(res.text).toContain('href="/register"');
    expect(res.text).toContain('href="/tv"');
    expect(res.text).toContain('The dungeon rests');         // idle boss fallback (no encounter)
  });

  it('GET /register shows the form with all 9 classes', async () => {
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Paladin');
    expect(res.text).toContain('name="class_key"');
  });

  it('GET /register emits both gender sprite URLs so the preview can swap', async () => {
    const res = await request(app).get('/register');
    // paladin: male sprite is _09.png, female is _18.png (maleIndex + 9)
    expect(res.text).toContain('data-sprite-m="/sprites/creatures_24x24/oryx_16bit_fantasy_creatures_09.png"');
    expect(res.text).toContain('data-sprite-f="/sprites/creatures_24x24/oryx_16bit_fantasy_creatures_18.png"');
    expect(res.text).toContain('function applyGender'); // the swap script is present
  });

  it('GET /register?class= preselects that fighter', async () => {
    const res = await request(app).get('/register?class=wizard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="class_key" value="wizard"');
    expect(res.text).toContain('data-key="wizard" onclick="pick(this)"'); // grid present
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
