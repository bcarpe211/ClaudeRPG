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
  for (const dir of ['src/web/views', 'src/web/public/tv', 'src/web/routes', 'src/domain', 'docs']) {
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
    expect(BRAND.primaryLines).toEqual([
      'Clock in.',
      'Clear dungeons.',
      'Get paid.',
    ]);
    expect(BRAND.primaryLines.join(' ')).toBe(BRAND.primaryLine);
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

  it('rejects Pi operator instructions that install, enable, or force-run the moving-main updater', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'docs/PI_SETUP.md'), [
      'sudo install -m 755 ~/ClaudeRPG/scripts/pi/auto-update.sh /usr/local/bin/claude-rpg-autoupdate',
      'sudo systemctl enable --now claude-rpg-autoupdate.timer',
      'sudo systemctl start claude-rpg-autoupdate',
    ].join('\n'));

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('docs/PI_SETUP.md:1: stale operator instruction: install moving-main updater');
    expect(result.output).toContain('docs/PI_SETUP.md:2: stale operator instruction: enable moving-main updater');
    expect(result.output).toContain('docs/PI_SETUP.md:3: stale operator instruction: force-run moving-main updater');
  });

  it('rejects legacy Pi onboarding and raw pull-restart release shortcuts', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'docs/PI_SETUP.md'), [
      'Paste the shown setup snippet into your shell and open a new terminal.',
      'Their Claude Code token usage then streams to the Pi.',
      '`rpg_off`/`rpg_on` toggle collection on-network.',
      'cd ~/ClaudeRPG && git pull --ff-only && sudo systemctl restart claude-rpg',
    ].join('\n'));

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('docs/PI_SETUP.md:1: stale operator instruction: install legacy telemetry snippet');
    expect(result.output).toContain('docs/PI_SETUP.md:2: stale operator instruction: score Claude Code token stream');
    expect(result.output).toContain('docs/PI_SETUP.md:3: stale operator instruction: use legacy rpg command');
    expect(result.output).toContain('docs/PI_SETUP.md:4: stale operator instruction: raw pull-restart release');
  });

  it('rejects a raw pull-restart release recipe split across consecutive lines', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'docs/PI_SETUP.md'), [
      '```bash',
      'git pull --ff-only',
      'sudo systemctl restart claude-rpg',
      '```',
    ].join('\n'));

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('docs/PI_SETUP.md:2: stale operator instruction: raw pull-restart release');
  });

  it('allows separate explicit retirement and pinned-runbook guidance', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'docs/PI_SETUP.md'), [
      'The old `git pull --ff-only` release shortcut is retired.',
      'Never pair it with `sudo systemctl restart claude-rpg`.',
      'Follow docs/RUNTIME_RAIDERS_CUTOVER.md for the separately authorized pinned-SHA procedure.',
    ].join('\n'));

    const result = runCopyCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('allows an explicitly retired same-line pull-restart shortcut', () => {
    const root = copyFixture();
    writeFileSync(
      join(root, 'docs/PI_SETUP.md'),
      'The old git pull --ff-only && sudo systemctl restart claude-rpg release shortcut is retired.\n',
    );

    const result = runCopyCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('rejects restoring, enabling, or starting the moving-main updater in the cutover plan', () => {
    const root = copyFixture();
    const planDir = join(root, 'docs/superpowers/plans');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, '2026-08-01-runtime-raiders-internal-deployment-cutover.md'), [
      'restore the auto-update timer only after acceptance',
      'sudo systemctl enable --now claude-rpg-autoupdate.timer',
      'sudo systemctl start claude-rpg-autoupdate',
    ].join('\n'));

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('docs/superpowers/plans/2026-08-01-runtime-raiders-internal-deployment-cutover.md:1: stale operator instruction: restore moving-main updater');
    expect(result.output).toContain('docs/superpowers/plans/2026-08-01-runtime-raiders-internal-deployment-cutover.md:2: stale operator instruction: enable moving-main updater');
    expect(result.output).toContain('docs/superpowers/plans/2026-08-01-runtime-raiders-internal-deployment-cutover.md:3: stale operator instruction: force-run moving-main updater');
  });

  it('allows explicit legacy retirement and compatibility wording', () => {
    const root = copyFixture();
    writeFileSync(join(root, 'docs/PI_SETUP.md'), [
      'Compatibility identifiers retained: /home/rluser/ClaudeRPG and claude-rpg-autoupdate.*.',
      'Claude Code and Omp are unavailable and unsupported.',
      'Manually remove the legacy Claude OTel shell configuration and old `rpg_*` commands.',
      'The current updater timer remains disabled and inactive; its oneshot remains inactive.',
    ].join('\n'));

    const result = runCopyCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('accepts the current Pi guide and cutover plan', () => {
    const root = copyFixture();
    const planDir = join(root, 'docs/superpowers/plans');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(root, 'docs/PI_SETUP.md'), readFileSync(join(process.cwd(), 'docs/PI_SETUP.md')));
    writeFileSync(
      join(planDir, '2026-08-01-runtime-raiders-internal-deployment-cutover.md'),
      readFileSync(join(process.cwd(), 'docs/superpowers/plans/2026-08-01-runtime-raiders-internal-deployment-cutover.md')),
    );

    const result = runCopyCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it('scans Bazaar view-model copy that is rendered on active player pages', () => {
    const root = copyFixture();
    writeFileSync(
      join(root, 'src/domain/shopview.ts'),
      "export const potionCopy = '50g per 1,000 effective tokens';\n",
    );

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('src/domain/shopview.ts:1');
    expect(result.output).toContain('stale player copy: effective tokens');
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

  it('rejects path-scoped legacy Raider identity and Raid Power copy', () => {
    const root = copyFixture();
    const residues = [
      ['src/web/public/player-hub.js', "progress.textContent = '1 / 2 tokens';\n"],
      ['src/web/public/tv/tv.js', "draw('1,000 tok'); draw('awaiting adventurers');\n"],
      ['src/web/routes/character.ts', "const title = 'Character Login'; const error = 'No character found for that token.';\n"],
      ['src/web/views/character-sheet.ejs', '<h2>Delete character</h2>\n'],
      ['src/web/views/character-login.ejs', '<p>View Raider sheet</p>\n'],
      ['src/web/views/registered.ejs', '<a>Open your Raider sheet</a>\n'],
      ['src/web/views/character-wardrobe.ejs', '<canvas aria-label="Live character dye preview"></canvas>\n'],
      ['src/web/public/dye.js', "const error = 'Character session expired — reload required';\n"],
      ['src/web/views/landing.ejs', '<span>3 adventurers contributing</span>\n'],
    ] as const;
    for (const [path, contents] of residues) writeFileSync(join(root, path), contents);

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    for (const [path] of residues) expect(result.output).toContain(`${path}:1`);
  });

  it('allows compatibility routes, hooks, and internal token fields in guarded paths', () => {
    const root = copyFixture();
    writeFileSync(
      join(root, 'src/web/routes/character.ts'),
      "app.get('/character', handler); app.post('/character/delete', handler);\n",
    );
    writeFileSync(
      join(root, 'src/web/views/character-sheet.ejs'),
      '<div class="character-avatar" id="hub-today-tokens"><%= player.effective_tokens %></div>\n',
    );
    writeFileSync(
      join(root, 'src/web/public/tv/tv.js'),
      'const value = participant.tokensDuringFight + player.effectiveTokens;\n',
    );
    writeFileSync(
      join(root, 'src/web/public/player-hub.css'),
      '.hub-character-settings .character-store { display: grid; }\n',
    );
    writeFileSync(
      join(root, 'src/web/public/player-hub.js'),
      'const payload = { token: bootstrap.token, raider_key: bootstrap.token };\n',
    );

    const result = runCopyCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toBe('');
  });

  it.each([
    [
      'src/web/views/character-sheet.ejs',
      '<p>The timer pauses whenever the dungeon is not accepting work.</p>\n',
    ],
    [
      'src/web/public/player-hub.js',
      "setText('potion-confirm-copy', 'The timer pauses whenever the dungeon is not accepting work.');\n",
    ],
  ])('rejects work-based potion timing copy in %s', (path, contents) => {
    const root = copyFixture();
    writeFileSync(join(root, path), contents);

    const result = runCopyCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain(`${path}:1`);
    expect(result.output).toContain('stale player copy: work-based potion timing');
  });
});
