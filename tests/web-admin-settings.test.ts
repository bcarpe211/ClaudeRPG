import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';
import { ensureAdmin } from '../src/domain/admin';
import {
  DEFAULT_SETTINGS,
  seedSettings,
  getSetting,
} from '../src/domain/settings';

let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof createApp>;
const config = loadConfig({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'secret' });

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ username: 'boss', password: 'secret' });
  return agent;
}

function potionSettings(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).filter(([key]) => key.startsWith('potion_')),
    ),
    ...overrides,
  };
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

  it('saves the complete potion configuration as one validated group', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send(potionSettings({
        potion_gold_t1_price: '110000',
        potion_damage_t1_base_hit_pct: '12.5',
      }));

    expect(res.status).toBe(302);
    expect(getSetting(db, 'potion_gold_t1_price')).toBe('110000');
    expect(getSetting(db, 'potion_damage_t1_base_hit_pct')).toBe('12.5');
  });

  it('rejects a partial potion group without saving any submitted setting', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({
        baseline_battle_minutes: '40',
        potion_gold_t1_price: '110000',
      });

    expect(res.status).toBe(400);
    expect(getSetting(db, 'baseline_battle_minutes')).toBe('45');
    expect(getSetting(db, 'potion_gold_t1_price')).toBe('100000');
  });

  it.each([
    ['zero duration', { potion_gold_t1_duration_s: '0' }],
    ['unsafe duration milliseconds', { potion_damage_t1_duration_s: '9007199254741' }],
    ['fractional economic value', { potion_gold_t1_price: '1.5' }],
    ['unsafe economic value', { potion_gold_t1_stretch_tokens: '9007199254740992' }],
    ['malformed effect value', { potion_damage_t1_base_hit_pct: 'not-a-number' }],
    ['negative daily limit', { potion_daily_uses_per_type: '-1' }],
  ])('rejects %s transactionally', async (_label, invalid) => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({
        baseline_battle_minutes: '40',
        ...potionSettings(invalid),
      });

    expect(res.status).toBe(400);
    expect(getSetting(db, 'baseline_battle_minutes')).toBe('45');
    for (const [key, value] of Object.entries(potionSettings())) {
      expect(getSetting(db, key), key).toBe(value);
    }
  });

  it('rejects a damage bonus above 1,000% without saving any setting', async () => {
    const agent = await adminAgent();
    const res = await agent
      .post('/admin/settings')
      .type('form')
      .send({
        baseline_battle_minutes: '40',
        ...potionSettings({ potion_damage_t1_base_hit_pct: '1000.0001' }),
      });

    expect(res.status).toBe(400);
    expect(getSetting(db, 'baseline_battle_minutes')).toBe('45');
    expect(getSetting(db, 'potion_damage_t1_base_hit_pct')).toBe('25');
  });

  it('never exposes the admin password hash as an editable knob', async () => {
    const agent = await adminAgent();
    const res = await agent.get('/admin/settings');
    expect(res.text).not.toContain('admin_password_hash');
  });
});
