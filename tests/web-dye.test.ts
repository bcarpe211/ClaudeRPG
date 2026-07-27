import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { getCosmetics } from '../src/domain/cosmetics';
import { createPlayer } from '../src/domain/players';
import { purchase, setCosmeticHue } from '../src/domain/shop';
import {
  beginSlotMutationSession,
  getSlotConfig,
  setSlotRule,
} from '../src/domain/slotcosmetics';
import { MATERIAL_PRESETS, wheelRule } from '../src/domain/dye';
import { SLOTS } from '../src/domain/slots';
import { seedSettings } from '../src/domain/settings';
import { createApp } from '../src/web/app';

function ctx(gender: 'M' | 'F' = 'M') {
  const db = openDb(':memory:');
  seedSettings(db);
  const app = createApp({ db, config: loadConfig({}) });
  const player = createPlayer(
    db,
    { name: 'A', class_key: 'wizard', gender },
    1,
  );
  db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
  const browserSession = beginSlotMutationSession(db, player.id);
  return { db, app, player, browserSession };
}

function buy(db: ReturnType<typeof openDb>, playerId: number, tier: 1 | 2 | 3) {
  const expectedPrice = [0, 1_500_000, 2_000_000, 2_500_000][tier];
  return purchase(db, playerId, `cosmetic_wheel_t${tier}`, expectedPrice, 10);
}

function dyeState(db: ReturnType<typeof openDb>, playerId: number) {
  return {
    config: [...getSlotConfig(db, playerId)],
    revisions: db.prepare(
      `SELECT slot, session, revision FROM player_slot_cosmetic_revisions
       WHERE player_id = ? ORDER BY slot`,
    ).all(playerId),
  };
}

function expectDyeState(
  db: ReturnType<typeof openDb>,
  playerId: number,
  expected: ReturnType<typeof dyeState>,
) {
  const actual = dyeState(db, playerId);
  expect(actual.config).toEqual(expected.config);
  expect(actual.revisions).toEqual(expected.revisions);
}

describe('character dye endpoints', () => {
  it('removes the character-page purchase endpoint', async () => {
    const { app, player } = ctx();
    expect((await request(app).post('/character/dye/unlock').type('form').send({ token: player.auth_token })).status).toBe(404);
  });

  it('returns 404 for an unknown token without mutating anything', async () => {
    const { app } = ctx();
    const res = await request(app).post('/character/dye/set').type('form').send({
      token: 'missing-token', slot: SLOTS.body, recipe: 'wheel', hue: 200,
      session: 1, revision: 1,
    });
    expect(res.status).toBe(404);
  });

  it('allows Tier-1 clothing but rejects Tier-3 weapon at Tier 1', async () => {
    const { db, app, player } = ctx();
    expect(buy(db, player.id, 1)).toMatchObject({ ok: true, tier: 1 });
    const clothing = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, tone: -0.25, session: 1, revision: 1 });
    const weapon = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.weapon, recipe: 'gold', session: 1, revision: 1 });
    expect(clothing.status).toBe(204);
    expect(weapon.status).toBe(403);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 200, sat: 0.6, tone: -0.25 });
  });

  it('keeps the newest set or clear when browser requests arrive out of order', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    const postSet = (revision: number, hue: number) => request(app)
      .post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue, session: 1, revision });
    const postClear = (revision: number) => request(app)
      .post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, session: 1, revision });

    expect((await postSet(2_000, 40)).status).toBe(204);
    expect((await postSet(2_002, 200)).status).toBe(204);
    expect((await postSet(2_002, 300)).status).toBe(409);
    expect((await postSet(2_001, 100)).status).toBe(409);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
      op: 'colorize', hue: 200, sat: 0.6, tone: 0,
    });

    expect((await postClear(2_004)).status).toBe(204);
    expect((await postSet(2_003, 80)).status).toBe(409);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(false);
    expect(db.prepare('SELECT session, revision FROM player_slot_cosmetic_revisions WHERE player_id = ? AND slot = ?')
      .get(player.id, SLOTS.body)).toEqual({ session: 1, revision: 2_004 });
  });

  it.each([
    { label: 'exact set replay', first: 'set', firstHue: 40, replay: 'set', replayHue: 40, seeded: false, expectedHue: 40 },
    { label: 'set to different set', first: 'set', firstHue: 40, replay: 'set', replayHue: 120, seeded: false, expectedHue: 40 },
    { label: 'set to clear', first: 'set', firstHue: 40, replay: 'clear', seeded: false, expectedHue: 40 },
    { label: 'clear to set', first: 'clear', replay: 'set', replayHue: 120, seeded: true, expectedHue: null },
  ])('returns 409 for equal-revision legacy $label and preserves the first mutation', async (scenario) => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    if (scenario.seeded) setSlotRule(db, player.id, SLOTS.body, wheelRule(20), 5);
    const post = (action: 'set' | 'clear', hue?: number) => request(app)
      .post(`/character/dye/${action}`).type('form').send({
        token: player.auth_token,
        slot: SLOTS.body,
        session: browserSession.session,
        revision: 1,
        ...(action === 'set' ? { recipe: 'wheel', hue } : {}),
      });

    expect((await post(scenario.first as 'set' | 'clear', scenario.firstHue)).status).toBe(204);
    expect((await post(scenario.replay as 'set' | 'clear', scenario.replayHue)).status).toBe(409);
    const stored = getSlotConfig(db, player.id).get(SLOTS.body);
    if (scenario.expectedHue === null) expect(stored).toBeUndefined();
    else expect(stored).toEqual({
      op: 'colorize', hue: scenario.expectedHue, sat: 0.6, tone: 0,
    });
  });

  it('keeps a same-tab final set when a reload has issued a newer session but not edited the slot', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const reloaded = beginSlotMutationSession(db, player.id);

    const res = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 40,
      session: browserSession.session, revision: 1,
    });

    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
      op: 'colorize', hue: 40, sat: 0.6, tone: 0,
    });
    expect(reloaded.session).toBeGreaterThan(browserSession.session);
  });

  it('accepts an older tab until a newer tab mutates the same slot, then rejects it', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const post = (endpoint: 'set' | 'clear', session: number, revision: number, hue?: number) => request(app)
      .post(`/character/dye/${endpoint}`).type('form').send({
        token: player.auth_token, slot: SLOTS.body, session, revision,
        ...(endpoint === 'set' ? { recipe: 'wheel', hue } : {}),
      });

    expect((await post('set', browserSession.session, 1, 40)).status).toBe(204);
    const newerTab = beginSlotMutationSession(db, player.id);
    expect((await post('set', newerTab.session, 1, 120)).status).toBe(204);
    expect((await post('set', browserSession.session, 2, 200)).status).toBe(409);
    expect((await post('set', newerTab.session + 1, 1, 300)).status).toBe(409);

    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
      op: 'colorize', hue: 120, sat: 0.6, tone: 0,
    });
    expect(db.prepare('SELECT session, revision FROM player_slot_cosmetic_revisions WHERE player_id = ? AND slot = ?')
      .get(player.id, SLOTS.body)).toEqual({ session: newerTab.session, revision: 1 });
  });

  it('rejects a session epoch that was never issued inside a former clock-sized gap', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    beginSlotMutationSession(db, player.id);

    const res = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200,
      session: 500, revision: 1,
    });

    expect(res.status).toBe(409);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(false);
  });

  it('accepts the exact Bronze recipe and bounded Tone override', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    const res = await request(app).post('/character/dye/set').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'bronze', tone: 0.2, session: 1, revision: 1 });
    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({ op: 'colorize', hue: 28, sat: 0.58, tone: 0.2 });
  });

  it('rejects invalid Tone without changing the stored rule', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(100), 20);
    for (const tone of ['1.01', '-1.01', 'NaN', 'Infinity']) {
      const res = await request(app).post('/character/dye/set').type('form')
        .send({ token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, tone, session: 1, revision: 1 });
      expect(res.status).toBe(400);
    }
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual(wheelRule(100));
  });

  it('rejects malformed recipes and hues without changing the stored rule', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(100), 20);
    for (const body of [
      { recipe: 'bogus' },
      { recipe: 'wheel', hue: 360 },
      { recipe: 'wheel', hue: -1 },
      { recipe: 'wheel', hue: 'NaN' },
    ]) {
      const res = await request(app).post('/character/dye/set').type('form').send({
        token: player.auth_token, slot: SLOTS.body, session: 1, revision: 1, ...body,
      });
      expect(res.status).toBe(400);
    }
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual(wheelRule(100));
  });

  it('does not clear a retained rule while its tier is locked', async () => {
    const { db, app, player } = ctx();
    setSlotRule(db, player.id, SLOTS.weapon, MATERIAL_PRESETS.gold, 10);
    buy(db, player.id, 1);
    const res = await request(app).post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.weapon, session: 1, revision: 1 });
    expect(res.status).toBe(403);
    expect(getSlotConfig(db, player.id).has(SLOTS.weapon)).toBe(true);
  });

  it('rejects an unavailable channel with 400', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    const res = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.facePaint, recipe: 'steel', session: 1, revision: 1,
    });
    expect(res.status).toBe(400);
  });

  it('rejects set and clear until the required tier is owned', async () => {
    const { app, player } = ctx();
    const set = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, session: 1, revision: 1,
    });
    const clear = await request(app).post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, session: 1, revision: 1 });
    expect(set.status).toBe(403);
    expect(clear.status).toBe(403);
  });

  it('restores true default even when a legacy body hue existed', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setCosmeticHue(db, player.id, 'primary', 210, 100);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(true);
    const res = await request(app).post('/character/dye/clear').type('form')
      .send({ token: player.auth_token, slot: SLOTS.body, session: 1, revision: 1 });
    expect(res.status).toBe(204);
    expect(getSlotConfig(db, player.id).has(SLOTS.body)).toBe(false);
  });
});

describe('character dye batch save endpoint', () => {
  it('applies one canonical multi-slot response and returns it again for an exact replay', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const save = (changes: unknown, revision = 1) => request(app)
      .post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision,
        changes: JSON.stringify(changes),
      });
    const changes = [
      { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 210, tone: -0.2 },
      { action: 'set', slot: SLOTS.headgear, recipe: 'gold', tone: 0.1 },
    ];

    const applied = await save(changes);

    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({
      config: {
        [SLOTS.body]: { op: 'colorize', hue: 210, sat: 0.6, tone: -0.2 },
        [SLOTS.headgear]: { op: 'colorize', hue: 46, sat: 0.75, tone: 0.1 },
      },
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(dyeState(db, player.id).revisions).toEqual([
      { slot: SLOTS.body, session: browserSession.session, revision: 1 },
      { slot: SLOTS.headgear, session: browserSession.session, revision: 1 },
    ]);
    const afterApplied = dyeState(db, player.id);

    const replay = await save(changes);

    expect(replay.status).toBe(200);
    expect(replay.text).toBe(applied.text);
    expectDyeState(db, player.id, afterApplied);
  });

  it('rejects a mixed authorized and locked batch without changing rules or revisions', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const save = (changes: unknown, revision = 1) => request(app)
      .post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision,
        changes: JSON.stringify(changes),
      });
    expect((await save([
      { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 80 },
    ])).status).toBe(200);
    const before = dyeState(db, player.id);

    expect((await save([
      { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 210 },
      { action: 'set', slot: SLOTS.weapon, recipe: 'gold' },
    ], 2)).status).toBe(403);
    expectDyeState(db, player.id, before);
  });

  it('rejects unavailable and duplicate slots without changing rules or revisions', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const save = (changes: unknown, revision = 1) => request(app)
      .post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision,
        changes: JSON.stringify(changes),
      });
    expect((await save([
      { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 80 },
    ])).status).toBe(200);
    const before = dyeState(db, player.id);

    expect((await save([
      { action: 'clear', slot: SLOTS.facePaint },
    ], 2)).status).toBe(403);
    expectDyeState(db, player.id, before);

    expect((await save([
      { action: 'clear', slot: SLOTS.body },
      { action: 'clear', slot: SLOTS.body },
    ], 3)).status).toBe(400);
    expectDyeState(db, player.id, before);
  });

  it('rejects malformed JSON and strict-schema violations without changing state', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(80), 10);
    const before = dyeState(db, player.id);
    const invalidRequests = [
      request(app).post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision: 1,
        changes: '{',
      }),
      request(app).post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision: 1,
        changes: JSON.stringify([]),
      }),
      request(app).post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision: 1,
        changes: JSON.stringify([
          { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 210, extra: true },
        ]),
      }),
      request(app).post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision: 1,
        changes: JSON.stringify([{ action: 'clear', slot: SLOTS.body }]),
        extra: true,
      }),
    ];

    for (const invalidRequest of invalidRequests) {
      expect((await invalidRequest).status).toBe(400);
      expectDyeState(db, player.id, before);
    }
  });

  it('rejects 13 changes without changing rules or revisions', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.body, wheelRule(80), 10);
    const before = dyeState(db, player.id);
    const changes = Array.from(
      { length: 13 },
      (_, slot) => ({ action: 'clear' as const, slot }),
    );

    const res = await request(app).post('/character/dye/save').type('form').send({
      token: player.auth_token,
      session: browserSession.session,
      revision: 1,
      changes: JSON.stringify(changes),
    });

    expect(res.status).toBe(400);
    expectDyeState(db, player.id, before);
  });

  it('returns 404 for an unknown token without changing rules or revisions', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const seeded = await request(app).post('/character/dye/save').type('form').send({
      token: player.auth_token,
      session: browserSession.session,
      revision: 1,
      changes: JSON.stringify([
        { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 80 },
      ]),
    });
    expect(seeded.status).toBe(200);
    const before = dyeState(db, player.id);

    const res = await request(app).post('/character/dye/save').type('form').send({
      token: 'missing-token',
      session: browserSession.session,
      revision: 2,
      changes: JSON.stringify([{ action: 'clear', slot: SLOTS.body }]),
    });

    expect(res.status).toBe(404);
    expectDyeState(db, player.id, before);
  });

  it('returns 409 for a stale mixed batch without changing rules or revisions', async () => {
    const { db, app, player, browserSession } = ctx();
    buy(db, player.id, 1);
    const save = (changes: unknown, revision = 1) => request(app)
      .post('/character/dye/save').type('form').send({
        token: player.auth_token,
        session: browserSession.session,
        revision,
        changes: JSON.stringify(changes),
      });
    expect((await save([
      { action: 'set', slot: SLOTS.body, recipe: 'wheel', hue: 210 },
      { action: 'set', slot: SLOTS.headgear, recipe: 'gold' },
    ], 5)).status).toBe(200);
    const before = dyeState(db, player.id);

    expect((await save([
      { action: 'clear', slot: SLOTS.body },
      { action: 'set', slot: SLOTS.skin, recipe: 'wheel', hue: 24 },
    ], 4)).status).toBe(409);
    expectDyeState(db, player.id, before);
  });
});

describe('character wardrobe panel', () => {
  it('shows Tier-0 locked previews and sends purchasing to the Bazaar', async () => {
    const { app, player } = ctx('F');
    const res = await request(app).get('/character').query({ token: player.auth_token });
    expect(res.text).toContain('Wardrobe Tier 0');
    expect(res.text).toContain('Tier 1');
    expect(res.text).toContain('Tier 2');
    expect(res.text).toContain('Tier 3');
    expect(res.text).toContain(
      `class="btn btn-gold character-store" href="/shop?token=${encodeURIComponent(player.auth_token)}"`,
    );
    expect(res.text).not.toContain('/character/dye/unlock');
    expect(res.text).not.toContain('window.__DYE__');
  });

  it('serializes only Tier-1 controls while showing higher tiers locked', async () => {
    const { db, app, player } = ctx('F');
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 10);
    const res = await request(app).get('/character').query({ token: player.auth_token });
    expect(res.text).toContain('Wardrobe Tier 1');
    expect(res.text).toContain('window.__DYE__');
    expect(res.text).toContain('data-slot="1"');
    expect(res.text).toContain('data-required-tier="3" disabled');
    expect(res.text).toContain('id="dye-tone"');
    expect(res.text).toContain('data-recipe="steel"');
    expect(res.text).toContain('data-recipe="bronze"');
    expect(res.text).toContain('data-recipe="gold"');
    expect(res.text).not.toContain('data-finish="black"');
    expect(res.text).not.toContain('data-finish="white"');
    expect(res.text).toContain('id="dye-save-status" class="dye-save-status" data-state="saved" role="status" aria-live="polite">Saved</span>');
    expect(res.text).toContain('id="dye-reload" type="button" class="btn btn-ghost dye-action dye-reload" hidden');
    expect(res.text).toContain('<span>Reload</span>');
    expect(res.text).toContain('<span>Discard</span>');
    expect(res.text).toContain('<span>Save</span>');
    const colorScript = res.text.indexOf('<script src="/static/dye-color.js"></script>');
    const draftScript = res.text.indexOf('<script src="/static/dye-draft.js"></script>');
    const clientScript = res.text.indexOf('<script src="/static/dye.js"></script>');
    expect(colorScript).toBeGreaterThan(-1);
    expect(draftScript).toBeGreaterThan(colorScript);
    expect(clientScript).toBeGreaterThan(draftScript);
  });

  it('places status on the fitting stage and closes the Tone flow with compact draft actions', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);

    const res = await request(app).get('/character').query({ token: player.auth_token });
    const stage = res.text.match(/<div class="dye-stage">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const tone = res.text.indexOf('class="dye-tone-label"');
    const finishes = res.text.indexOf('class="dye-finishes"');
    const restore = res.text.indexOf('data-recipe="none"');
    const actionLabel = res.text.indexOf('class="dye-action-label"');
    const actions = res.text.indexOf('class="dye-action-strip"');

    expect(stage).toContain('id="dye-save-status"');
    expect(stage).toContain('role="status" aria-live="polite"');
    expect(tone).toBeGreaterThan(-1);
    expect(finishes).toBeGreaterThan(tone);
    expect(restore).toBeGreaterThan(finishes);
    expect(actionLabel).toBeGreaterThan(restore);
    expect(actions).toBeGreaterThan(actionLabel);
    expect(res.text).toContain('id="dye-reload" type="button" class="btn btn-ghost dye-action dye-reload" hidden');
    expect(res.text).toContain('<span>Reload</span>');
    expect(res.text).toContain('<span>Discard</span>');
    expect(res.text).toContain('<span>Save</span>');
  });

  it('serializes exact material presets without locked Tier-3 rules', async () => {
    const { db, app, player } = ctx();
    buy(db, player.id, 1);
    setSlotRule(db, player.id, SLOTS.weapon, MATERIAL_PRESETS.gold, 20);

    const res = await request(app).get('/character').query({ token: player.auth_token });

    expect(res.text).toContain('"steel":{"op":"colorize","hue":212,"sat":0.13,"tone":0}');
    expect(res.text).toContain('"bronze":{"op":"colorize","hue":28,"sat":0.58,"tone":-0.12}');
    expect(res.text).toContain('"gold":{"op":"colorize","hue":46,"sat":0.75,"tone":0.1}');
    expect(res.text).not.toContain(`"7":{"op":"colorize","hue":46,"sat":0.75,"tone":0.1}`);
  });

  it('removes the purchase prompt at Tier 3 while keeping the complete workbench', async () => {
    const { db, app, player } = ctx();
    db.prepare('UPDATE players SET gold = 7000000 WHERE id = ?').run(player.id);
    purchase(db, player.id, 'cosmetic_wheel_t1', 1_500_000, 1);
    purchase(db, player.id, 'cosmetic_wheel_t2', 2_000_000, 2);
    purchase(db, player.id, 'cosmetic_wheel_t3', 2_500_000, 3);
    const res = await request(app).get('/character').query({ token: player.auth_token });
    expect(res.text).toContain('Wardrobe Tier 3');
    expect(res.text).toContain('Dye mastery complete');
    expect(res.text).not.toContain('Unlock the next tier');
  });

  it('persists a rule for an authored female channel after Tier 1', async () => {
    const { db, app, player } = ctx('F');
    buy(db, player.id, 1);
    const set = await request(app).post('/character/dye/set').type('form').send({
      token: player.auth_token, slot: SLOTS.body, recipe: 'wheel', hue: 200, session: 1, revision: 1,
    });
    expect(set.status).toBe(204);
    expect(getSlotConfig(db, player.id).get(SLOTS.body)).toEqual({
      op: 'colorize', hue: 200, sat: 0.6, tone: 0,
    });
  });
});
