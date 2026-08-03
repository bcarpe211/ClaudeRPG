import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

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
  const caddyConfig = join(root, 'deployed-Caddyfile');
  const approvedCaddy = join(root, 'approved-Caddyfile');
  const caddyEnv = join(root, 'caddy.env');
  const releaseSha = 'b'.repeat(40);
  const cutoverAt = '1790000000000';
  const fakes = join(root, 'fakes');
  const commandLog = join(root, 'commands.log');
  const pauseState = join(root, 'pause-state');

  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(dirname(db), { recursive: true });
  mkdirSync(dirname(policy), { recursive: true });
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(join(repo, 'src', 'domain'), { recursive: true });
  mkdirSync(fakes);
  writeFileSync(db, 'production-shaped-database');
  copyFileSync(resolve('config/raid-power-policy-v1.json'), policy);
  copyFileSync(resolve('src/domain/raid-power-policy.ts'), join(repo, 'src/domain/raid-power-policy.ts'));
  copyFileSync(resolve('package.json'), join(repo, 'package.json'));
  symlinkSync(resolve('node_modules'), join(repo, 'node_modules'), 'dir');
  writeFileSync(join(repo, 'deploy', 'Caddyfile'), 'raiders.redlattice.com, clauderpg.redlattice.com {}\n');
  writeFileSync(caddyConfig, readFileSync(join(repo, 'deploy', 'Caddyfile')));
  writeFileSync(approvedCaddy, readFileSync(join(repo, 'deploy', 'Caddyfile')));
  writeFileSync(caddyEnv, 'CLOUDFLARE_API_TOKEN=top-secret-caddy-token\n');
  writeFileSync(commandLog, '');
  writeFileSync(pauseState, '0\n');

  writeFileSync(envFile, [
    'ADMIN_PASSWORD=top-secret-password',
    'SESSION_SECRET=top-secret-session',
    `DB_PATH=${db}`,
    'PUBLIC_URL=https://raiders.redlattice.com',
    'SCORING_MODE=runtime-raiders',
    `RUN_SCORING_CUTOVER_AT=${cutoverAt}`,
    `RAID_POWER_POLICY_PATH=${policy}`,
    'RUN_ENABLED_SURFACES=codex_desktop,codex_cli',
    '',
  ].join('\n'));

  executable(join(fakes, 'sqlite3'), `
case "$*" in
  *integrity_check*) printf '%s\\n' "\${FAKE_INTEGRITY:-ok}" ;;
  *page_count*page_size*) printf '%s\\n%s\\n' "\${FAKE_PAGE_COUNT:-1}" "\${FAKE_PAGE_SIZE:-4096}" ;;
  *paused*)
    pause_count=0
    if [ -f "$RUNTIME_RAIDERS_TEST_PAUSE_STATE" ]; then IFS= read -r pause_count < "$RUNTIME_RAIDERS_TEST_PAUSE_STATE"; fi
    pause_count=$((pause_count + 1))
    printf '%s\\n' "$pause_count" > "$RUNTIME_RAIDERS_TEST_PAUSE_STATE"
    if [ "$pause_count" -gt 1 ]; then printf '%s\\n' "\${FAKE_FINAL_PAUSED:-\${FAKE_PAUSED:-1}}"; else printf '%s\\n' "\${FAKE_PAUSED:-1}"; fi ;;
  *) exit 72 ;;
esac`);

  executable(join(fakes, 'git'), `
[ "\${1:-}" = "-C" ] || exit 73
shift 2
case "$*" in
  'rev-parse --show-toplevel') printf '%s\\n' "$RUNTIME_RAIDERS_TEST_REPO" ;;
  'rev-parse HEAD') printf '%s\\n' "\${FAKE_LOCAL_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" ;;
  'status --porcelain') [ "\${FAKE_GIT_DIRTY:-0}" = 0 ] || printf '%s\\n' ' M local-change' ;;
  'rev-parse --verify origin/main^{commit}') printf '%s\\n' "\${FAKE_TARGET_SHA:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" ;;
  show\\ *:deploy/Caddyfile) /bin/cat "$RUNTIME_RAIDERS_TEST_APPROVED_CADDY" ;;
  'merge-base --is-ancestor HEAD origin/main') [ "\${FAKE_GIT_DIVERGED:-0}" = 0 ] ;;
  *) exit 74 ;;
esac`);

  executable(join(fakes, 'caddy'), `
[ "$*" = "validate --config $RUNTIME_RAIDERS_TEST_CADDY_CONFIG --adapter caddyfile --envfile $RUNTIME_RAIDERS_TEST_CADDY_ENV" ]
[ "\${FAKE_CADDY_VALID:-1}" = 1 ]`);
  executable(join(fakes, 'curl'), `
case "$*" in
  *https://raiders.redlattice.com/health*) [ "\${FAKE_NEW_HTTPS:-1}" = 1 ] ;;
  *https://clauderpg.redlattice.com/health*) [ "\${FAKE_OLD_HTTPS:-1}" = 1 ] ;;
  *) exit 75 ;;
esac`);
  executable(join(fakes, 'hostname'), `
case "$*" in
  --short) printf '%s\\n' "\${FAKE_HOSTNAME:-raiders}" ;;
  -I) printf '%s\\n' "\${FAKE_LOCAL_ADDRESSES:-192.0.2.10}" ;;
  *) exit 78 ;;
esac`);
  executable(join(fakes, 'getent'), `
name=\${2:-}
if [ "$name" = 'raiders.local' ]; then
  [ "\${FAKE_TARGET_HOST_RESOLVES:-1}" = 1 ] || exit 1
else
  exit 76
fi
printf '%s %s\\n' "\${FAKE_RESOLVED_IP:-192.0.2.10}" "$name"`);
  executable(join(fakes, 'systemctl'), `
case "$*" in
  'is-active claude-rpg.service')
    if [ "\${FAKE_SERVER_ACTIVE:-1}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'is-enabled claude-rpg-autoupdate.timer')
    if [ "\${FAKE_TIMER_ENABLED:-0}" = 1 ]; then printf '%s\\n' enabled; else printf '%s\\n' disabled; exit 1; fi ;;
  'is-active claude-rpg-autoupdate.timer')
    if [ "\${FAKE_TIMER_ACTIVE:-0}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'is-active avahi-daemon.service')
    if [ "\${FAKE_AVAHI_ACTIVE:-1}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  *) exit 77 ;;
esac`);
  executable(join(fakes, 'du'), 'printf \'%s\\t%s\\n\' "${FAKE_RELEASE_KB:-100}" "$RUNTIME_RAIDERS_TEST_REPO"');
  executable(join(fakes, 'df'), `printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fake 1000000 1 '"\${FAKE_FREE_KB:-1000}"' 1% /'`);
  executable(join(fakes, 'cmp'), 'exec /usr/bin/cmp "$@"');
  for (const command of ['hostnamectl', 'rm', 'apt', 'apt-get', 'npm', 'tee', 'sed', 'cp', 'mv', 'install']) {
    executable(join(fakes, command), 'exit 91');
  }

  return { root, repo, db, envFile, policy, caddyConfig, approvedCaddy, caddyEnv, releaseSha, cutoverAt, fakes, commandLog, pauseState };
}

function run(testFixture: Fixture, overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', [
    SCRIPT,
    '--db', testFixture.db,
    '--env', testFixture.envFile,
    '--repo', testFixture.repo,
    '--release-sha', testFixture.releaseSha,
    '--cutover-at', testFixture.cutoverAt,
    '--caddy-config', testFixture.caddyConfig,
    '--caddy-env', testFixture.caddyEnv,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${testFixture.fakes}:${dirname(process.execPath)}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_COMMAND_LOG: testFixture.commandLog,
      RUNTIME_RAIDERS_TEST_REPO: testFixture.repo,
      RUNTIME_RAIDERS_TEST_PAUSE_STATE: testFixture.pauseState,
      RUNTIME_RAIDERS_TEST_CADDY_CONFIG: testFixture.caddyConfig,
      RUNTIME_RAIDERS_TEST_APPROVED_CADDY: testFixture.approvedCaddy,
      RUNTIME_RAIDERS_TEST_CADDY_ENV: testFixture.caddyEnv,
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
  it('rejects origin/main when it is not the explicitly approved release SHA', () => {
    const result = run(fixture(), { FAKE_TARGET_SHA: 'c'.repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Git readiness');
  });

  it('rejects an ahead release while the auto-updater timer is active', () => {
    const result = run(fixture(), { FAKE_TIMER_ACTIVE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL systemd units');
  });

  it('rejects an environment cutover that differs from the explicitly approved timestamp', () => {
    const f = fixture();
    f.cutoverAt = '1790000000001';
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('rejects the checked-in placeholder even when supplied as the expected timestamp', () => {
    const f = fixture();
    f.cutoverAt = '1800000000000';
    replaceAssignment(f.envFile, 'RUN_SCORING_CUTOVER_AT', f.cutoverAt);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('rejects a policy document that the application policy loader rejects', () => {
    const f = fixture();
    const invalidPolicy = {
      ...JSON.parse(readFileSync(f.policy, 'utf8')),
      unexpected_release_field: true,
    };
    writeFileSync(f.policy, `${JSON.stringify(invalidPolicy)}\n`);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('rejects a deployed Caddy config that differs from the reviewed candidate', () => {
    const f = fixture();
    writeFileSync(f.caddyConfig, 'different.example.test {}\n');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
  });

  it('binds the deployed Caddy config to the candidate at the approved release SHA', () => {
    const f = fixture();
    writeFileSync(f.approvedCaddy, 'approved-release.example.test {}\n');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
  });

  it('rejects a dungeon that changes from paused to active before READY', () => {
    const result = run(fixture(), { FAKE_PAUSED: '1', FAKE_FINAL_PAUSED: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL final game paused');
  });

  it('requires the Pi to have the exact raiders hostname', () => {
    const result = run(fixture(), { FAKE_HOSTNAME: 'claude-rpg' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL hostname resolution');
  });

  it('rejects raiders.local when it resolves to a non-local address', () => {
    const result = run(fixture(), {
      FAKE_HOSTNAME: 'raiders',
      FAKE_LOCAL_ADDRESSES: '192.0.2.10',
      FAKE_RESOLVED_IP: '198.51.100.20',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL hostname resolution');
  });

  it('requires Avahi to be active on the Pi', () => {
    const result = run(fixture(), { FAKE_HOSTNAME: 'raiders', FAKE_AVAHI_ACTIVE: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL systemd units');
  });

  it('pins both HTTPS health checks to the verified local address without proxy routing', () => {
    const result = run(fixture(), { FAKE_HOSTNAME: 'raiders' });
    expect(result.status, result.output).toBe(0);
    expect(result.commands).toContain('--noproxy * --resolve raiders.redlattice.com:443:192.0.2.10');
    expect(result.commands).toContain('--noproxy * --resolve clauderpg.redlattice.com:443:192.0.2.10');
  });

  it('sizes two backups from the live SQLite snapshot rather than the small main file', () => {
    const f = fixture();
    rmSync(f.db);
    rmSync(join(f.fakes, 'sqlite3'));
    const database = new Database(f.db);
    try {
      database.pragma('journal_mode = WAL');
      database.pragma('wal_autocheckpoint = 0');
      database.exec(`
        CREATE TABLE game_state (id INTEGER PRIMARY KEY, paused INTEGER NOT NULL);
        INSERT INTO game_state (id, paused) VALUES (1, 1);
        CREATE TABLE wal_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
      `);
      database.pragma('wal_checkpoint(TRUNCATE)');
      const insert = database.prepare('INSERT INTO wal_payload (payload) VALUES (?)');
      database.transaction(() => {
        for (let index = 0; index < 480; index += 1) insert.run(Buffer.alloc(4096, index % 251));
      })();

      const backup = join(f.root, 'full-backup.db');
      const backupResult = spawnSync('/usr/bin/sqlite3', [f.db, `.backup '${backup}'`], { encoding: 'utf8' });
      expect(backupResult.status, backupResult.stderr).toBe(0);
      const mainBytes = statSync(f.db).size;
      const walBytes = statSync(`${f.db}-wal`).size;
      const backupBytes = statSync(backup).size;
      expect(walBytes).toBeGreaterThan(mainBytes);
      expect(backupBytes).toBeGreaterThan(mainBytes);

      const releaseKb = 100;
      const oldMainFileBudgetKb = releaseKb + (2 * Math.ceil(mainBytes / 1024));
      const snapshotMarginBudgetKb = releaseKb + (2 * Math.ceil((backupBytes * 1.1) / 1024));
      const availableKb = snapshotMarginBudgetKb - 1;
      expect(availableKb).toBeGreaterThan(oldMainFileBudgetKb);

      const result = run(f, {
        FAKE_RELEASE_KB: String(releaseKb),
        FAKE_FREE_KB: String(availableKb),
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('FAIL disk capacity');
    } finally {
      database.close();
    }
  });

  it.each([
    ['repository', (f: Fixture) => rmSync(f.repo, { recursive: true }), 'FAIL paths'],
    ['database', (f: Fixture) => rmSync(f.db), 'FAIL paths'],
    ['environment', (f: Fixture) => rmSync(f.envFile), 'FAIL paths'],
    ['policy', (f: Fixture) => rmSync(f.policy), 'FAIL Runtime Raiders environment'],
    ['deployed Caddy config', (f: Fixture) => rmSync(f.caddyConfig), 'FAIL paths'],
    ['protected Caddy environment', (f: Fixture) => rmSync(f.caddyEnv), 'FAIL paths'],
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

  it('rejects failed target hostname resolution', () => {
    const result = run(fixture(), { FAKE_TARGET_HOST_RESOLVES: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL hostname resolution');
  });

  it.each([
    ['server', { FAKE_SERVER_ACTIVE: '0' }],
    ['enabled updater timer', { FAKE_TIMER_ENABLED: '1' }],
    ['active updater timer', { FAKE_TIMER_ACTIVE: '1' }],
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
    expect(result.output).not.toContain('top-secret-caddy-token');
  });

  it('uses only observed read-only commands and leaves DB, env, and policy fixtures unchanged', () => {
    const f = fixture();
    const protectedFixtures = [f.db, f.envFile, f.policy, f.caddyConfig, f.caddyEnv];
    const before = protectedFixtures.map((path) => readFileSync(path, 'utf8'));
    const result = run(f);
    const after = protectedFixtures.map((path) => readFileSync(path, 'utf8'));

    expect(result.status, result.output).toBe(0);
    expect(after).toEqual(before);
    expect(result.commands).toContain('sqlite3 -readonly');
    expect(result.commands).toContain('git -C');
    expect(result.commands).toContain('caddy validate');
    expect(result.commands).toContain('cmp -s');
    expect(result.commands).toContain('curl');
    expect(result.commands).toContain('systemctl is-active');
    expect(result.commands).not.toMatch(/systemctl (restart|reload|start|stop|enable|disable)/);
    expect(result.commands).not.toMatch(/hostnamectl set-hostname/);
    expect(result.commands).not.toMatch(/\s(?:pull|fetch|merge(?!-base)|reset|checkout|switch|clean)(?:\s|$)/);
    expect(result.commands).not.toMatch(/sqlite3 .*\.(restore|backup)|sqlite3 .*\b(VACUUM|UPDATE|INSERT|DELETE|ALTER|DROP|CREATE)\b/i);
    expect(result.commands).not.toMatch(/\b(apt|apt-get|npm) (install|ci)\b/);
    expect(result.commands).not.toMatch(/^(?:hostnamectl|rm|tee|sed|cp|mv|install)\b/m);
    expect(result.commands.trim().split('\n').at(-1)).toContain('SELECT paused FROM game_state');
  });
});
