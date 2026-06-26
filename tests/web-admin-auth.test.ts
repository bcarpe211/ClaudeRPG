import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import { seedSettings } from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });

beforeEach(() => {
  db = openDb(':memory:');
  seedSettings(db);
  ensureAdmin(db, config.adminUsername, config.adminPassword);
  app = createApp({ db, config });
});

describe('admin auth', () => {
  it('redirects to login when not authenticated', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('rejects bad credentials', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ username: 'boss', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('logs in with good credentials and reaches the dashboard', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/admin/login')
      .type('form')
      .send({ username: 'boss', password: 'secret' });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/admin');
    const dash = await agent.get('/admin');
    expect(dash.status).toBe(200);
  });
});
