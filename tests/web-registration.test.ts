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
  app = createApp({
    db,
    config: loadConfig({ RUN_ENABLED_SURFACES: 'codex_desktop,codex_cli' }),
  });
});

describe('registration', () => {
  it('GET / introduces the Runs-and-Raiders loop without legacy telemetry support claims', async () => {
    // Catches a landing page that advertises a legacy telemetry setup or an unsupported surface.
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Clock in. Clear dungeons. Get paid.');
    expect(res.text).toContain('Get paid means in-game gold and rewards.');
    expect(res.text).toContain('Create Your Raider');
    expect(res.text).toContain('Create your Raider.');
    expect(res.text).toContain('Install the private local companion.');
    expect(res.text).toContain('Use Codex Desktop or CLI; your Runs generate Raid Power.');
    expect(res.text).toContain('Supported Run surfaces: Codex Desktop and Codex CLI.');
    expect(res.text).toContain(
      'It scans local provider records for approved Run metadata and usage counters. Work content is not extracted into Run metadata or transmitted.',
    );
    expect(res.text).toContain('Run metadata:</strong> provider, supported surface, usage counts, model, effort, timestamps, Run state');
    expect(res.text).toContain('It never sends:</strong> prompts, responses, commands, tool details, code, files, paths, workspaces, shell history');
    expect(res.text).not.toContain('It reads local Run metadata and usage counters, never work content.');
    expect(res.text).not.toContain('It reads usage numbers, nothing else.');
    expect(res.text).not.toMatch(/never (?:reads|scans)[^<.]*work content/i);
    expect(res.text).not.toContain('It sees:</strong>');
    expect(res.text).not.toContain('OTEL_RESOURCE_ATTRIBUTES');
    expect(res.text).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(res.text).not.toContain('Claude Code only');
    expect(res.text).not.toContain('ClaudeRPG');
    expect(res.text).not.toContain('Omp');
    expect(res.text).not.toContain('Claude Code');
    expect(res.text).not.toContain('adventurer');
    expect(res.text).toContain('href="/register"');
    expect(res.text).toContain('href="/tv"');
    expect(res.text).toContain('The dungeon rests');
    expect(res.text).toContain('href="/static/dungeon.css"');
    expect(res.text).toContain('class="wall wall-l"');
    expect(res.text).toContain('href="/static/landing.css"');
  });

  it('GET / fails closed when its configured surfaces include an unsupported public label', async () => {
    // Catches a landing page that invents or partially publishes a disabled support matrix.
    const restrictedApp = createApp({
      db: openDb(':memory:'),
      config: loadConfig({ RUN_ENABLED_SURFACES: 'codex_desktop,omp' }),
    });

    const res = await request(restrictedApp).get('/');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Supported Run surfaces:');
    expect(res.text).not.toContain('Codex Desktop');
    expect(res.text).not.toContain('Omp');
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

  it('GET /register?class= preselects that Raider class', async () => {
    const res = await request(app).get('/register?class=wizard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="class_key" value="wizard"');
    expect(res.text).toContain('data-key="wizard" onclick="pick(this)"'); // grid present
  });

  it('POST /register creates one Raider and a ten-minute enrollment without putting the Raider Key in the installer', async () => {
    // Catches registration that reuses the persistent Raider Key as an installer credential.
    const before = Date.now();
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({ name: 'Sir Reginald', class_key: 'knight', gender: 'M' });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.text).toContain('Raider Key');
    expect(res.text).toContain('<code>raiders on</code> resumes collection.');
    expect(res.text).toContain('<code>raiders off</code> pauses collection.');
    expect(res.text).toContain('<code>raiders status</code> reports your current state and supported surfaces.');
    expect(res.text).toContain('<code>raiders doctor</code> diagnoses setup without exporting secrets or content.');
    expect(res.text).toContain('<code>raiders uninstall</code> stops and removes only Runtime Raiders-owned companion files.');
    expect(res.text).toContain('Open your Raider Hub');
    expect(res.text).not.toContain('Raider sheet');
    const players = listPlayers(db);
    expect(players.length).toBe(1);
    expect(players[0].name).toBe('Sir Reginald');
    expect(res.text).toContain(players[0].auth_token);

    const enrollments = db.prepare(`
      SELECT created_at, expires_at
      FROM raider_enrollments
      WHERE player_id = ?
    `).all(players[0].id) as Array<{ created_at: number; expires_at: number }>;
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].expires_at - enrollments[0].created_at).toBe(10 * 60_000);
    expect(enrollments[0].created_at).toBeGreaterThanOrEqual(before);
    expect(enrollments[0].created_at).toBeLessThanOrEqual(after);

    const installCommand = res.text.match(/curl -fsSL (?:'|&#39;)[^'&]+(?:'|&#39;) \| sh -s -- --code (?:'|&#39;)([A-Za-z0-9_-]{43})(?:'|&#39;)/)?.[0];
    const oneTimeCode = res.text.match(/--code (?:'|&#39;)([A-Za-z0-9_-]{43})(?:'|&#39;)/)?.[1];
    expect(installCommand).toBeDefined();
    expect(oneTimeCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(installCommand).not.toContain(players[0].auth_token);
  });

  it('POST /register rolls back a forced enrollment failure before a retry creates its first Raider', async () => {
    // Catches a player committed before its Raider identity and enrollment can be created.
    db.exec(`
      CREATE TRIGGER reject_raider_enrollment
      BEFORE INSERT ON raider_enrollments
      BEGIN
        SELECT RAISE(ABORT, 'forced enrollment failure');
      END;
    `);

    const failed = await request(app)
      .post('/register')
      .type('form')
      .send({ name: 'Atomic Raider', class_key: 'knight', gender: 'M' });

    expect(failed.status).toBe(500);
    expect(listPlayers(db)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM raider_identities').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM raider_enrollments').get())
      .toEqual({ count: 0 });

    db.exec('DROP TRIGGER reject_raider_enrollment');
    const retried = await request(app)
      .post('/register')
      .type('form')
      .send({ name: 'Atomic Raider', class_key: 'knight', gender: 'M' });

    expect(retried.status).toBe(200);
    expect(listPlayers(db)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM raider_identities').get())
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM raider_enrollments').get())
      .toEqual({ count: 1 });
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
