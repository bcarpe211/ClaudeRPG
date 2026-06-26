import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import { seedSettings } from '../src/domain/settings';
import { createPlayer, getPlayerById } from '../src/domain/players';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ username: 'boss', password: 'secret' });
  return agent;
}

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  ensureAdmin(db, config.adminUsername, config.adminPassword);
  app = createApp({ db, config });
});

describe('admin players', () => {
  it('lists players on the dashboard', async () => {
    createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gandalf');
  });

  it('updates a player via the edit form', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent
      .post(`/admin/players/${p.id}`)
      .type('form')
      .send({ name: 'Saruman', class_key: 'wizard', gender: 'M', level: '7', gold: '500', disabled: '1' });
    expect(res.status).toBe(302);
    const u = getPlayerById(db, p.id)!;
    expect(u.name).toBe('Saruman');
    expect(u.level).toBe(7);
    expect(u.gold).toBe(500);
    expect(u.disabled).toBe(1);
  });

  it('deletes a player', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent.post(`/admin/players/${p.id}/delete`).type('form').send({});
    expect(res.status).toBe(302);
    expect(getPlayerById(db, p.id)).toBeUndefined();
  });

  it('blocks player management when not authenticated', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
  });
});
