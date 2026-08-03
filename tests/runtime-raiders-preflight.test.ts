import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/pi/runtime-raiders-preflight.sh');
const roots: string[] = [];

type Fixture = ReturnType<typeof fixture>;

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\ncommand_name=\${0##*/}\nprintf '%s\\n' "$command_name $*" >> "$RUNTIME_RAIDERS_TEST_COMMAND_LOG"\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-preflight-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const db = join(repo, 'data', 'claude-rpg.db');
  const envFile = join(root, 'candidate.env');
  const policy = join(repo, 'config', 'raid-power-policy-v1.json');
  const fakes = join(root, 'fakes');
  const commandLog = join(root, 'commands.log');

  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(dirname(db), { recursive: true });
  mkdirSync(dirname(policy), { recursive: true });
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(fakes);
  writeFileSync(db, 'production-shaped-database');
  writeFileSync(policy, '{"policy_version":1,"enabled_providers":["codex"]}\n');
  writeFileSync(join(repo, 'deploy', 'Caddyfile'), 'raiders.redlattice.com, clauderpg.redlattice.com {}\n');
  writeFileSync(commandLog, '');

  writeFileSync(envFile, [
    'ADMIN_PASSWORD=top-secret-password',
    'SESSION_SECRET=top-secret-session',
    `DB_PATH=${db}`,
    'PUBLIC_URL=https://raiders.redlattice.com',
    'SCORING_MODE=runtime-raiders',
    'RUN_SCORING_CUTOVER_AT=1800000000000',
    `RAID_POWER_POLICY_PATH=${policy}`,
    'RUN_ENABLED_SURFACES=codex_desktop,codex_cli',
    '',
  ].join('\n'));

  executable(join(fakes, 'sqlite3'), `
case "$*" in
  *integrity_check*) printf '%s\\n' "\${FAKE_INTEGRITY:-ok}" ;;
  *paused*) printf '%s\\n' "\${FAKE_PAUSED:-1}" ;;
  *) exit 72 ;;
esac`);

  executable(join(fakes, 'git'), `
[ "\${1:-}" = "-C" ] || exit 73
shift 2
case "$*" in
  'rev-parse --show-toplevel') printf '%s\\n' "$RUNTIME_RAIDERS_TEST_REPO" ;;
  'status --porcelain') [ "\${FAKE_GIT_DIRTY:-0}" = 0 ] || printf '%s\\n' ' M local-change' ;;
  'rev-parse --verify origin/main^{commit}') printf '%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' ;;
  'merge-base --is-ancestor HEAD origin/main') [ "\${FAKE_GIT_DIVERGED:-0}" = 0 ] ;;
  *) exit 74 ;;
esac`);

  executable(join(fakes, 'caddy'), '[ "${FAKE_CADDY_VALID:-1}" = 1 ]');
  executable(join(fakes, 'curl'), `
case "$*" in
  *https://raiders.redlattice.com/health*) [ "\${FAKE_NEW_HTTPS:-1}" = 1 ] ;;
  *https://clauderpg.redlattice.com/health*) [ "\${FAKE_OLD_HTTPS:-1}" = 1 ] ;;
  *) exit 75 ;;
esac`);
  executable(join(fakes, 'hostname'), 'printf \'%s\\n\' "${FAKE_HOSTNAME:-claude-rpg}"');
  executable(join(fakes, 'getent'), `
name=\${2:-}
if [ "$name" = "\${FAKE_HOSTNAME:-claude-rpg}.local" ]; then
  [ "\${FAKE_CURRENT_HOST_RESOLVES:-1}" = 1 ] || exit 1
elif [ "$name" = 'raiders.local' ]; then
  [ "\${FAKE_TARGET_HOST_RESOLVES:-1}" = 1 ] || exit 1
else
  exit 76
fi
printf '%s\\n' '192.0.2.10 host.local'`);
  executable(join(fakes, 'systemctl'), `
case "$*" in
  'is-active --quiet claude-rpg.service') [ "\${FAKE_SERVER_ACTIVE:-1}" = 1 ] ;;
  'is-enabled --quiet claude-rpg-autoupdate.timer') [ "\${FAKE_TIMER_ENABLED:-1}" = 1 ] ;;
  'is-active --quiet claude-rpg-autoupdate.timer') [ "\${FAKE_TIMER_ACTIVE:-1}" = 1 ] ;;
  *) exit 77 ;;
esac`);
  executable(join(fakes, 'stat'), 'printf \'%s\\n\' "${FAKE_DB_BYTES:-4096}"');
  executable(join(fakes, 'du'), 'printf \'%s\\t%s\\n\' "${FAKE_RELEASE_KB:-100}" "$RUNTIME_RAIDERS_TEST_REPO"');
  executable(join(fakes, 'df'), `printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fake 1000000 1 '"\${FAKE_FREE_KB:-1000}"' 1% /'`);
  for (const command of ['hostnamectl', 'rm', 'apt', 'apt-get', 'npm', 'tee', 'sed', 'cp', 'mv', 'install']) {
    executable(join(fakes, command), 'exit 91');
  }

  return { root, repo, db, envFile, policy, fakes, commandLog };
}

function run(testFixture: Fixture, overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', [SCRIPT, '--db', testFixture.db, '--env', testFixture.envFile, '--repo', testFixture.repo], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${testFixture.fakes}:${dirname(process.execPath)}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_COMMAND_LOG: testFixture.commandLog,
      RUNTIME_RAIDERS_TEST_REPO: testFixture.repo,
      ...overrides,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    commands: readFileSync(testFixture.commandLog, 'utf8'),
  };
}

function replaceAssignment(path: string, key: string, value?: string): void {
  const lines = readFileSync(path, 'utf8').split('\n');
  const next = lines.filter((line) => !line.startsWith(`${key}=`));
  if (value !== undefined) next.splice(next.length - 1, 0, `${key}=${value}`);
  writeFileSync(path, next.join('\n'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Runtime Raiders Pi preflight', () => {
  it.each([
    ['repository', (f: Fixture) => rmSync(f.repo, { recursive: true }), 'FAIL paths'],
    ['database', (f: Fixture) => rmSync(f.db), 'FAIL paths'],
    ['environment', (f: Fixture) => rmSync(f.envFile), 'FAIL paths'],
    ['policy', (f: Fixture) => rmSync(f.policy), 'FAIL Runtime Raiders environment'],
  ])('fails closed when the required %s path is missing', (_name, remove, message) => {
    const f = fixture();
    remove(f);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(message);
  });

  it('rejects a database whose SQLite integrity check is not ok', () => {
    const result = run(fixture(), { FAKE_INTEGRITY: 'malformed' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL database integrity');
  });

  it('rejects an active dungeon', () => {
    const result = run(fixture(), { FAKE_PAUSED: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL game paused');
  });

  it('requires the explicit cutover timestamp', () => {
    const f = fixture();
    replaceAssignment(f.envFile, 'RUN_SCORING_CUTOVER_AT');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('requires Runtime Raiders scoring mode', () => {
    const f = fixture();
    replaceAssignment(f.envFile, 'SCORING_MODE', 'legacy');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it.each([
    ['dirty worktree', { FAKE_GIT_DIRTY: '1' }],
    ['diverged target', { FAKE_GIT_DIVERGED: '1' }],
  ])('rejects a %s', (_name, environment) => {
    const result = run(fixture(), environment);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Git readiness');
  });

  it('rejects an invalid Caddy candidate', () => {
    const result = run(fixture(), { FAKE_CADDY_VALID: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
  });

  it.each([
    ['new', { FAKE_NEW_HTTPS: '0' }, 'FAIL HTTPS new host'],
    ['old', { FAKE_OLD_HTTPS: '0' }, 'FAIL HTTPS old host'],
  ])('rejects failed %s-host HTTPS health', (_name, environment, message) => {
    const result = run(fixture(), environment);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(message);
  });

  it.each([
    ['current', { FAKE_CURRENT_HOST_RESOLVES: '0' }],
    ['target', { FAKE_TARGET_HOST_RESOLVES: '0' }],
  ])('rejects failed %s hostname resolution', (_name, environment) => {
    const result = run(fixture(), environment);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL hostname resolution');
  });

  it.each([
    ['server', { FAKE_SERVER_ACTIVE: '0' }],
    ['disabled updater timer', { FAKE_TIMER_ENABLED: '0' }],
    ['inactive updater timer', { FAKE_TIMER_ACTIVE: '0' }],
  ])('rejects an unhealthy %s unit state', (_name, environment) => {
    const result = run(fixture(), environment);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL systemd units');
  });

  it('requires room for two full database backups plus release files', () => {
    const result = run(fixture(), {
      FAKE_DB_BYTES: '4096',
      FAKE_RELEASE_KB: '100',
      FAKE_FREE_KB: '107',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL disk capacity');
  });

  it('reports every gate ready only when all checks pass', () => {
    const result = run(fixture());
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('PASS paths');
    expect(result.output).toContain('PASS database integrity');
    expect(result.output).toContain('PASS game paused');
    expect(result.output).toContain('PASS Git readiness');
    expect(result.output).toContain('PASS Runtime Raiders environment');
    expect(result.output).toContain('PASS Caddy configuration');
    expect(result.output).toContain('PASS HTTPS new host');
    expect(result.output).toContain('PASS HTTPS old host');
    expect(result.output).toContain('PASS hostname resolution');
    expect(result.output).toContain('PASS systemd units');
    expect(result.output).toContain('PASS disk capacity');
    expect(result.output).not.toContain('top-secret-password');
    expect(result.output).not.toContain('top-secret-session');
  });

  it('uses only observed read-only commands and leaves DB, env, and policy fixtures unchanged', () => {
    const f = fixture();
    const before = [f.db, f.envFile, f.policy].map((path) => readFileSync(path, 'utf8'));
    const result = run(f);
    const after = [f.db, f.envFile, f.policy].map((path) => readFileSync(path, 'utf8'));

    expect(result.status, result.output).toBe(0);
    expect(after).toEqual(before);
    expect(result.commands).toContain('sqlite3 -readonly');
    expect(result.commands).toContain('git -C');
    expect(result.commands).toContain('caddy validate');
    expect(result.commands).toContain('curl');
    expect(result.commands).toContain('systemctl is-active');
    expect(result.commands).not.toMatch(/systemctl (restart|reload|start|stop|enable|disable)/);
    expect(result.commands).not.toMatch(/hostnamectl set-hostname/);
    expect(result.commands).not.toMatch(/\s(?:pull|fetch|merge(?!-base)|reset|checkout|switch|clean)(?:\s|$)/);
    expect(result.commands).not.toMatch(/sqlite3 .*\.(restore|backup)|sqlite3 .*\b(VACUUM|UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/i);
    expect(result.commands).not.toMatch(/\b(apt|apt-get|npm) (install|ci)\b/);
    expect(result.commands).not.toMatch(/^(?:hostnamectl|rm|tee|sed|cp|mv|install)\b/m);
  });
});
