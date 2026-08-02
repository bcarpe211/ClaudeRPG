import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  it('brands the login as Runtime Raiders administration', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Runtime Raiders admin');
  });

  it('lists players on the dashboard', async () => {
    createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Gandalf');
    expect(res.text).toContain('Raiders (1)');
    expect(res.text).toContain('<th>Raid Power</th>');
  });

  it('labels compatibility totals without changing edit field names', async () => {
    const p = createPlayer(db, { name: 'Gandalf', class_key: 'wizard', gender: 'M' }, 1000);
    const agent = await adminAgent();
    const res = await agent.get(`/admin/players/${p.id}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Edit Raider: Gandalf');
    expect(res.text).toContain('Raid Power');
    expect(res.text).toContain('name="effective_tokens"');
    expect(res.text).toContain('Legacy raw-token total');
    expect(res.text).not.toContain('name="total_tokens"');
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
    expect(db.prepare("SELECT reason FROM gold_ledger WHERE reason='admin_adjustment'").get())
      .toEqual({ reason: 'admin_adjustment' });
    expect(db.prepare("SELECT balance_after FROM gold_ledger WHERE reason='admin_adjustment'").get())
      .toEqual({ balance_after: u.gold });
  });

  it.each([
    ['level', { level: '9007199254740992' }],
    ['gold', { gold: '9007199254740992' }],
    ['effective tokens', { effective_tokens: '9007199254740992' }],
  ])('rejects unsafe %s before writing any player field', async (_label, override) => {
    const p = createPlayer(
      db,
      { name: 'Original', class_key: 'wizard', gender: 'M' },
      1000,
    );
    const agent = await adminAgent();
    const res = await agent
      .post(`/admin/players/${p.id}`)
      .type('form')
      .send({
        name: 'Changed',
        class_key: 'thief',
        gender: 'F',
        level: '7',
        gold: '500',
        effective_tokens: '600',
        disabled: '1',
        ...override,
      });

    expect(res.status).toBe(400);
    expect(getPlayerById(db, p.id)).toMatchObject({
      name: 'Original',
      class_key: 'wizard',
      gender: 'M',
      level: 1,
      gold: 0,
      effective_tokens: 0,
      disabled: 0,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM gold_ledger WHERE reason='admin_adjustment'",
    ).get()).toEqual({ count: 0 });
  });

  it('rolls back profile fields when the gold ledger write fails', async () => {
    const p = createPlayer(
      db,
      { name: 'Atomic Original', class_key: 'wizard', gender: 'M' },
      1000,
    );
    db.exec(`
      CREATE TRIGGER fail_admin_gold_ledger
      BEFORE INSERT ON gold_ledger
      WHEN NEW.reason='admin_adjustment'
      BEGIN
        SELECT RAISE(ABORT, 'forced admin ledger failure');
      END;
    `);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const agent = await adminAgent();
    const res = await agent
      .post(`/admin/players/${p.id}`)
      .type('form')
      .send({
        name: 'Atomic Changed',
        class_key: 'thief',
        gender: 'F',
        level: '7',
        gold: '500',
        effective_tokens: '600',
        disabled: '1',
      });
    errorLog.mockRestore();

    expect(res.status).toBe(500);
    expect(getPlayerById(db, p.id)).toMatchObject({
      name: 'Atomic Original',
      class_key: 'wizard',
      gender: 'M',
      level: 1,
      gold: 0,
      effective_tokens: 0,
      disabled: 0,
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM gold_ledger WHERE reason='admin_adjustment'",
    ).get()).toEqual({ count: 0 });
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
