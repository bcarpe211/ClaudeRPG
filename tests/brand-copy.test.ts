import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
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

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
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
    const wordmark = res.text.match(/<a class="brand" href="\/">([\s\S]*?)<\/a>/)?.[1];

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Register — Runtime Raiders</title>');
    expect(wordmark).toContain('Runtime Raiders');
    expect(wordmark).not.toContain('CLAUDE');
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
});
