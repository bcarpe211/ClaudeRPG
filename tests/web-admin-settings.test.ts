import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import { seedSettings, getSetting } from '../src/domain/settings';

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

describe('admin settings', () => {
  it('shows friendly labels, descriptions, and defaults (not just raw keys)', async () => {
    const agent = await adminAgent();
    const res = await agent.get('/admin/settings');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="pause_after_minutes"'); // input still posts by raw key
    expect(res.text).toContain('Idle-pause delay');           // friendly label
    expect(res.text).toContain('the dungeon rests');          // description text
    expect(res.text).toContain('default:');                   // default shown
    expect(res.text).toContain('Activity modifier');          // a group heading
  });

  it('updates a knob', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({ baseline_battle_minutes: '40', pause_after_minutes: '20' });
    expect(res.status).toBe(302);
    expect(getSetting(db, 'baseline_battle_minutes')).toBe('40');
    expect(getSetting(db, 'pause_after_minutes')).toBe('20');
  });

  it('updates all reward percentages when they total 100', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({
        reward_work_pct: '70',
        reward_damage_pct: '20',
        reward_podium_first_pct: '5',
        reward_podium_second_pct: '3',
        reward_podium_third_pct: '2',
      });
    expect(res.status).toBe(302);
    expect(getSetting(db, 'reward_work_pct')).toBe('70');
    expect(getSetting(db, 'reward_damage_pct')).toBe('20');
  });

  it('rejects an invalid reward total without saving any reward percentage', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({
        reward_work_pct: '79',
        reward_damage_pct: '10',
        reward_podium_first_pct: '5',
        reward_podium_second_pct: '3',
        reward_podium_third_pct: '2',
      });
    expect(res.status).toBe(400);
    expect(getSetting(db, 'reward_work_pct')).toBe('80');
    expect(getSetting(db, 'reward_damage_pct')).toBe('10');
    expect(getSetting(db, 'reward_podium_first_pct')).toBe('5');
    expect(getSetting(db, 'reward_podium_second_pct')).toBe('3');
    expect(getSetting(db, 'reward_podium_third_pct')).toBe('2');
  });

  it('never exposes the admin password hash as an editable knob', async () => {
    const agent = await adminAgent();
    const res = await agent.get('/admin/settings');
    expect(res.text).not.toContain('admin_password_hash');
  });
});
