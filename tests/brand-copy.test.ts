import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { BRAND, TERMS } from '../src/domain/brand';
import { openDb } from '../src/db/db';
import { loadConfig } from '../src/config';
import { createApp } from '../src/web/app';

const fixtureRoots: string[] = [];
const bodyProbe = join('src/web/views', 'brand-copy-probe.ejs');

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
  rmSync(bodyProbe, { force: true });
});

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-copy-'));
  fixtureRoots.push(root);
  for (const dir of ['src/web/views', 'src/web/public', 'src/domain']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'src/domain/settings-meta.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/domain/playerhub.ts'), 'export {};\n');
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  return root;
}

function runCopyCheck(root: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', ['tools/runtime-raiders/check-player-copy.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RUNTIME_RAIDERS_COPY_ROOT: root },
    });
    return { status: 0, output };
  } catch (error: unknown) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }
}

describe('Runtime Raiders brand copy', () => {
  it('documents the collector path boundary without claiming local paths are absent', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
      .replace(/\s+/g, ' ');

    expect(readme).toContain(
      'Local absolute provider-record paths and read cursors are retained only in owner-only collector operational state',
    );
    expect(readme).toContain('They are never transmitted to the Runtime Raiders server.');
    expect(readme).toContain(
      'The Run metadata pipeline does **not** extract or transmit prompt text, response text, tool content or arguments',
    );
    expect(readme).not.toContain('does **not** collect or send prompt text, response text, tool');
    expect(readme).not.toContain('or provider-record paths.');
  });

  it('documents Raid Power while Runs are open and bounded credit at completion', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
      .replace(/\s+/g, ' ');

    expect(readme).toContain('powered by AI Runs as they unfold');
    expect(readme).toContain('observes Run lifecycle and cumulative usage while each Run is open');
    expect(readme).toContain(
      "Completion adds only the policy's bounded completion and duration credit.",
    );
    expect(readme).toContain(
      'Elapsed wall time does not create a sustained or recurring Momentum bonus.',
    );
    expect(readme).not.toContain('powered by completed AI Runs');
    expect(readme).not.toContain('observes completed Runs');
  });

  it('exposes the player-facing Runtime Raiders brand contract', () => {
    expect(BRAND).toEqual(expect.objectContaining({
      name: 'Runtime Raiders',
      primaryLine: 'Clock in. Clear dungeons. Get paid.',
      secondaryLine: 'Your AI keeps running. Your Raider keeps raiding.',
    }));
    expect(TERMS.leaderboard).toBe('Leaderboard');
    expect(Object.isFrozen(BRAND)).toBe(true);
    expect(Object.isFrozen(TERMS)).toBe(true);
  });

  it('renders the Runtime Raiders title suffix and global wordmark', async () => {
    const app = createApp({ db: openDb(':memory:'), config: loadConfig({}) });
    const res = await request(app).get('/register');
    const wordmark = res.text.match(/<a\b(?=[^>]*\bclass="brand")(?=[^>]*\baria-label="Runtime Raiders")[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Create Your Raider — Runtime Raiders</title>');
    expect(wordmark).toContain('<strong class="brand-primary">RUNTIME</strong>');
    expect(wordmark).toContain('<span class="brand-companion">RAIDERS</span>');
    expect(wordmark).not.toContain('CLAUDE');
  });

  it('supplies protected brand and terms objects to body views', async () => {
    writeFileSync(bodyProbe, '<%= brand.primaryLine %>|<%= terms.leaderboard %>');

    const { renderPage } = await import('../src/web/app');
    const page = await renderPage('brand-copy-probe', {
      brand: { primaryLine: 'Caller-controlled brand' },
      terms: { leaderboard: 'Caller-controlled term' },
    });

    expect(page).toContain('Clock in. Clear dungeons. Get paid.|Leaderboard');
    expect(page).not.toContain('Caller-controlled');
  });

  it('rejects stale player copy and permits same-line compatibility markers', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'src/web/views/stale.ejs'), 'Welcome to ClaudeRPG\n');
    writeFileSync(join(root, 'src/web/public/compat.js'), 'const oldCommand = "rpg_on"; // runtime-raiders-copy-allow\n');

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('src/web/views/stale.ejs:1');
    expect(result.output).toContain('ClaudeRPG');
    expect(result.output).not.toContain('src/web/public/compat.js:1');
  });

  it('accepts active copy without stale terms', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'src/web/views/landing.ejs'), 'Runtime Raiders are ready.\n');
    writeFileSync(join(root, 'src/web/public/compat.js'), 'const oldCommand = "rpg_off"; // runtime-raiders-copy-allow\n');

    const result = runCopyCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('rejects case variants of every forbidden term', () => {
    const root = copyFixture();
    const variants = [
      ['clauderpg', 'ClaudeRPG'],
      ['claude code ONLY', 'Claude Code only'],
      ['RPG_ON', 'rpg_on'],
      ['RPG_OFF', 'rpg_off'],
      ['Effective Tokens', 'effective tokens'],
      ['total TOKENS', 'Total tokens'],
    ];
    writeFileSync(
      join(root, 'src/web/views/case-variants.ejs'),
      variants.map(([variant]) => variant).join('\n'),
    );

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    for (const [, term] of variants) expect(result.output).toContain(`stale player copy: ${term}`);
  });
});
