import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
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
  const spritesDir = join(repo, 'assets', 'oryx_16-bit_fantasy_1.1', 'Sliced');
  const envFile = join(root, 'candidate.env');
  const policy = join(repo, 'config', 'raid-power-policy-v1.json');
  const caddyConfig = join(root, 'deployed-Caddyfile');
  const approvedCaddy = join(root, 'approved-Caddyfile');
  const approvedPolicy = join(root, 'approved-policy.json');
  const approvedPolicyLoader = join(root, 'approved-policy-loader.ts');
  const caddyEnv = join(root, 'caddy.env');
  const artifactRoot = join(root, 'artifact-store');
  const releaseSha = 'b'.repeat(40);
  const priorSha = 'a'.repeat(40);
  const cutoverAt = '1790000000000';
  const fakes = join(root, 'fakes');
  const commandLog = join(root, 'commands.log');
  const pauseState = join(root, 'pause-state');
  const updaterState = join(root, 'updater-state');
  const gitState = join(root, 'git-state');

  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(dirname(db), { recursive: true });
  mkdirSync(dirname(policy), { recursive: true });
  mkdirSync(spritesDir, { recursive: true });
  mkdirSync(join(repo, 'deploy'), { recursive: true });
  mkdirSync(join(repo, 'src', 'domain'), { recursive: true });
  mkdirSync(join(artifactRoot, 'releases'), { recursive: true, mode: 0o755 });
  chmodSync(artifactRoot, 0o755);
  chmodSync(join(artifactRoot, 'releases'), 0o755);
  mkdirSync(fakes);
  writeFileSync(db, 'production-shaped-database');
  copyFileSync(resolve('config/raid-power-policy-v1.json'), policy);
  copyFileSync(resolve('src/domain/raid-power-policy.ts'), join(repo, 'src/domain/raid-power-policy.ts'));
  copyFileSync(resolve('package.json'), join(repo, 'package.json'));
  symlinkSync(resolve('node_modules'), join(repo, 'node_modules'), 'dir');
  writeFileSync(join(repo, 'deploy', 'Caddyfile'), 'raiders.redlattice.com, clauderpg.redlattice.com {}\n');
  writeFileSync(caddyConfig, readFileSync(join(repo, 'deploy', 'Caddyfile')));
  writeFileSync(approvedCaddy, readFileSync(join(repo, 'deploy', 'Caddyfile')));
  copyFileSync(policy, approvedPolicy);
  copyFileSync(join(repo, 'src/domain/raid-power-policy.ts'), approvedPolicyLoader);
  writeFileSync(caddyEnv, 'CLOUDFLARE_API_TOKEN=top-secret-caddy-token\n');
  chmodSync(caddyEnv, 0o600);
  writeFileSync(commandLog, '');
  writeFileSync(pauseState, '0\n');
  writeFileSync(updaterState, '0\n');
  mkdirSync(gitState);

  writeFileSync(envFile, [
    'PORT=8080',
    'ADMIN_USERNAME=admin',
    'ADMIN_PASSWORD=top-secret-password',
    'SESSION_SECRET=top-secret-session',
    `DB_PATH=${db}`,
    `SPRITES_DIR=${spritesDir}`,
    'PUBLIC_URL=https://raiders.redlattice.com',
    'SCORING_MODE=runtime-raiders',
    `RUN_SCORING_CUTOVER_AT=${cutoverAt}`,
    `RAID_POWER_POLICY_PATH=${policy}`,
    'RUN_ENABLED_SURFACES=codex_desktop,codex_cli',
    '',
  ].join('\n'));
  chmodSync(envFile, 0o600);

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
[ "\${1:-}" = "--no-optional-locks" ] || exit 73
shift
[ "\${1:-}" = "-C" ] || exit 73
shift 2
next_count() {
  count_file="$RUNTIME_RAIDERS_TEST_GIT_STATE/$1"
  count=0
  if [ -f "$count_file" ]; then IFS= read -r count < "$count_file"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$count_file"
}
case "$*" in
  'rev-parse --show-toplevel') printf '%s\\n' "$RUNTIME_RAIDERS_TEST_REPO" ;;
  'rev-parse HEAD')
    next_count head
    if [ "$count" -gt 1 ]; then printf '%s\\n' "\${FAKE_FINAL_LOCAL_SHA:-\${FAKE_LOCAL_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}"; else printf '%s\\n' "\${FAKE_LOCAL_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"; fi ;;
  'status --porcelain')
    next_count status
    if [ "$count" -gt 1 ]; then dirty="\${FAKE_FINAL_GIT_DIRTY:-\${FAKE_GIT_DIRTY:-0}}"; else dirty="\${FAKE_GIT_DIRTY:-0}"; fi
    [ "$dirty" = 0 ] || printf '%s\\n' ' M local-change' ;;
  'rev-parse --verify origin/main^{commit}')
    next_count target
    if [ "$count" -gt 1 ]; then printf '%s\\n' "\${FAKE_FINAL_TARGET_SHA:-\${FAKE_TARGET_SHA:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}}"; else printf '%s\\n' "\${FAKE_TARGET_SHA:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"; fi ;;
  show\\ *:deploy/Caddyfile) /bin/cat "$RUNTIME_RAIDERS_TEST_APPROVED_CADDY" ;;
  show\\ *:config/raid-power-policy-v1.json) /bin/cat "$RUNTIME_RAIDERS_TEST_APPROVED_POLICY" ;;
  show\\ *:src/domain/raid-power-policy.ts) /bin/cat "$RUNTIME_RAIDERS_TEST_APPROVED_POLICY_LOADER" ;;
  ls-tree\\ -r\\ -l\\ *) printf '%s\\n' "100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \${FAKE_TARGET_TREE_BYTES:-102400}\ttarget-file" ;;
  merge-base\\ --is-ancestor\\ *)
    next_count ancestry
    if [ "$count" -gt 1 ]; then diverged="\${FAKE_FINAL_GIT_DIVERGED:-\${FAKE_GIT_DIVERGED:-0}}"; else diverged="\${FAKE_GIT_DIVERGED:-0}"; fi
    [ "$diverged" = 0 ] ;;
  *) exit 74 ;;
esac`);

  executable(join(fakes, 'caddy'), `
[ "$*" = "validate --config $RUNTIME_RAIDERS_TEST_CADDY_CONFIG --adapter caddyfile --envfile $RUNTIME_RAIDERS_TEST_CADDY_ENV" ]
[ "\${FAKE_CADDY_VALID:-1}" = 1 ]`);
  executable(join(fakes, 'curl'), `
case "$*" in
  *https://raiders.redlattice.com/install.sh*|\
  *https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip*|\
  *https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256*|\
  *https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json*)
    printf '%s' "\${FAKE_ARTIFACT_HTTP_STATUS:-404}" ;;
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
  addresses="\${FAKE_RESOLVED_IP:-192.0.2.10}"
elif [ "$name" = 'raiders.redlattice.com' ]; then
  addresses="\${FAKE_NEW_DNS_IP:-192.0.2.10}"
elif [ "$name" = 'clauderpg.redlattice.com' ]; then
  addresses="\${FAKE_OLD_DNS_IP:-192.0.2.10}"
else
  exit 76
fi
for address in $addresses; do printf '%s %s\\n' "$address" "$name"; done`);
  executable(join(fakes, 'systemctl'), `
case "$*" in
  'is-active claude-rpg.service')
    if [ "\${FAKE_SERVER_ACTIVE:-1}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'is-enabled claude-rpg-autoupdate.timer')
    if [ "\${FAKE_TIMER_ENABLED:-0}" = 1 ]; then printf '%s\\n' enabled; else printf '%s\\n' disabled; exit 1; fi ;;
  'is-active claude-rpg-autoupdate.timer')
    if [ "\${FAKE_TIMER_ACTIVE:-0}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'is-active claude-rpg-autoupdate.service')
    updater_count=0
    if [ -f "$RUNTIME_RAIDERS_TEST_UPDATER_STATE" ]; then IFS= read -r updater_count < "$RUNTIME_RAIDERS_TEST_UPDATER_STATE"; fi
    updater_count=$((updater_count + 1))
    printf '%s\\n' "$updater_count" > "$RUNTIME_RAIDERS_TEST_UPDATER_STATE"
    if [ "$updater_count" -gt 1 ]; then updater_active="\${FAKE_FINAL_UPDATER_SERVICE_ACTIVE:-\${FAKE_UPDATER_SERVICE_ACTIVE:-0}}"; else updater_active="\${FAKE_UPDATER_SERVICE_ACTIVE:-0}"; fi
    if [ "$updater_active" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'is-active avahi-daemon.service')
    if [ "\${FAKE_AVAHI_ACTIVE:-1}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'is-active caddy.service')
    if [ "\${FAKE_CADDY_ACTIVE:-1}" = 1 ]; then printf '%s\\n' active; else printf '%s\\n' inactive; exit 3; fi ;;
  'show caddy.service --property=ExecStart --value')
    printf '%s\\n' "{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --config \${FAKE_CADDY_LOADED_CONFIG:-$RUNTIME_RAIDERS_TEST_CADDY_CONFIG} ; ignore_errors=no ; }" ;;
  'show caddy.service --property=EnvironmentFiles --value')
    printf '%s\\n' "\${FAKE_CADDY_LOADED_ENV:-$RUNTIME_RAIDERS_TEST_CADDY_ENV} (ignore_errors=no)" ;;
  'cat caddy.service')
    printf '%s\\n' '[Service]' \
      "EnvironmentFile=\${FAKE_CADDY_UNIT_ENV:-$RUNTIME_RAIDERS_TEST_CADDY_ENV}" \
      "ExecStart=/usr/bin/caddy run --config \${FAKE_CADDY_UNIT_CONFIG:-$RUNTIME_RAIDERS_TEST_CADDY_CONFIG}" ;;
  *) exit 77 ;;
esac`);
  executable(join(fakes, 'stat'), `
[ "\${1:-}" = '-c' ] && [ "\${3:-}" = '--' ] || exit 79
case "\${2:-}:\${4:-}" in
  "%u %a:$RUNTIME_RAIDERS_TEST_ENV") printf '%s %s\\n' "\${FAKE_GAME_ENV_UID:-0}" "\${FAKE_GAME_ENV_MODE:-600}" ;;
  "%u %a:$RUNTIME_RAIDERS_TEST_CADDY_ENV") printf '%s %s\\n' "\${FAKE_CADDY_ENV_UID:-0}" "\${FAKE_CADDY_ENV_MODE:-600}" ;;
  "%u:%g:%a:$RUNTIME_RAIDERS_TEST_ARTIFACT_ROOT"|"%u:%g:%a:$RUNTIME_RAIDERS_TEST_ARTIFACT_ROOT/releases")
    mode=$("$RUNTIME_RAIDERS_TEST_NODE" -e 'const { statSync } = require("node:fs"); process.stdout.write((statSync(process.argv[1]).mode & 0o777).toString(8));' "\${4:-}") || exit 80
    if [ "\${4:-}" = "$RUNTIME_RAIDERS_TEST_ARTIFACT_ROOT" ]; then mode="\${FAKE_ARTIFACT_ROOT_MODE:-$mode}"; fi
    printf '0:0:%s\\n' "$mode" ;;
  *) exit 80 ;;
esac`);
  executable(join(fakes, 'du'), 'printf \'%s\\t%s\\n\' "${FAKE_NODE_MODULES_KB:-100}" "$1"');
  executable(join(fakes, 'df'), `printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fake 4000000 1 '"\${FAKE_FREE_KB:-2000000}"' 1% /'`);
  executable(join(fakes, 'cmp'), 'exec /usr/bin/cmp "$@"');
  for (const command of ['hostnamectl', 'rm', 'apt', 'apt-get', 'npm', 'tee', 'sed', 'cp', 'mv', 'install']) {
    executable(join(fakes, command), 'exit 91');
  }

  return { root, repo, db, spritesDir, envFile, policy, caddyConfig, approvedCaddy, approvedPolicy, approvedPolicyLoader, caddyEnv, artifactRoot, releaseSha, priorSha, cutoverAt, fakes, commandLog, pauseState, updaterState, gitState };
}

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function realGitFixture(largeTargetBytes = 0): Fixture {
  const f = fixture();
  const canonicalRoot = realpathSync(f.root);
  for (const key of [
    'repo', 'db', 'spritesDir', 'envFile', 'policy', 'caddyConfig', 'approvedCaddy', 'approvedPolicy',
    'approvedPolicyLoader', 'caddyEnv', 'artifactRoot', 'fakes', 'commandLog', 'pauseState', 'updaterState', 'gitState',
  ] as const) {
    f[key] = f[key].replace(f.root, canonicalRoot);
  }

  rmSync(f.repo, { recursive: true, force: true });
  mkdirSync(join(f.repo, 'deploy'), { recursive: true });
  writeFileSync(join(f.repo, '.gitignore'), 'data/\nnode_modules\n');
  writeFileSync(join(f.repo, 'tracked.txt'), 'prior release\n');
  writeFileSync(join(f.repo, 'deploy/Caddyfile'), 'raiders.redlattice.com, clauderpg.redlattice.com {}\n');
  git(f.repo, ['init', '-q']);
  git(f.repo, ['add', '.gitignore', 'tracked.txt', 'deploy/Caddyfile']);
  git(f.repo, ['-c', 'user.name=Preflight Test', '-c', 'user.email=preflight@example.invalid', 'commit', '-qm', 'prior']);
  f.priorSha = git(f.repo, ['rev-parse', 'HEAD']);

  mkdirSync(join(f.repo, 'config'), { recursive: true });
  mkdirSync(join(f.repo, 'src/domain'), { recursive: true });
  copyFileSync(resolve('config/raid-power-policy-v1.json'), join(f.repo, 'config/raid-power-policy-v1.json'));
  copyFileSync(resolve('src/domain/raid-power-policy.ts'), join(f.repo, 'src/domain/raid-power-policy.ts'));
  if (largeTargetBytes > 0) writeFileSync(join(f.repo, 'large-target.bin'), Buffer.alloc(largeTargetBytes, 0x41));
  git(f.repo, ['add', 'config', 'src', ...(largeTargetBytes > 0 ? ['large-target.bin'] : [])]);
  git(f.repo, ['-c', 'user.name=Preflight Test', '-c', 'user.email=preflight@example.invalid', 'commit', '-qm', 'release']);
  f.releaseSha = git(f.repo, ['rev-parse', 'HEAD']);
  git(f.repo, ['update-ref', 'refs/remotes/origin/main', f.releaseSha]);
  git(f.repo, ['checkout', '-q', '--detach', f.priorSha]);

  mkdirSync(dirname(f.db), { recursive: true });
  mkdirSync(f.spritesDir, { recursive: true });
  writeFileSync(f.db, 'production-shaped-database');
  symlinkSync(resolve('node_modules'), join(f.repo, 'node_modules'), 'dir');
  replaceAssignment(f.envFile, 'DB_PATH', f.db);
  replaceAssignment(f.envFile, 'SPRITES_DIR', f.spritesDir);
  replaceAssignment(f.envFile, 'RAID_POWER_POLICY_PATH', join(f.repo, 'config/raid-power-policy-v1.json'));
  writeFileSync(f.caddyConfig, 'raiders.redlattice.com, clauderpg.redlattice.com {}\n');
  rmSync(join(f.fakes, 'git'));
  return f;
}

function run(testFixture: Fixture, overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', [
    SCRIPT,
    '--db', testFixture.db,
    '--env', testFixture.envFile,
    '--repo', testFixture.repo,
    '--prior-sha', testFixture.priorSha,
    '--release-sha', testFixture.releaseSha,
    '--cutover-at', testFixture.cutoverAt,
    '--caddy-config', testFixture.caddyConfig,
    '--caddy-env', testFixture.caddyEnv,
    '--artifact-root', testFixture.artifactRoot,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${testFixture.fakes}:${dirname(process.execPath)}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_COMMAND_LOG: testFixture.commandLog,
      RUNTIME_RAIDERS_TEST_REPO: testFixture.repo,
      RUNTIME_RAIDERS_TEST_PAUSE_STATE: testFixture.pauseState,
      RUNTIME_RAIDERS_TEST_UPDATER_STATE: testFixture.updaterState,
      RUNTIME_RAIDERS_TEST_GIT_STATE: testFixture.gitState,
      RUNTIME_RAIDERS_TEST_ENV: testFixture.envFile,
      RUNTIME_RAIDERS_TEST_CADDY_CONFIG: testFixture.caddyConfig,
      RUNTIME_RAIDERS_TEST_APPROVED_CADDY: testFixture.approvedCaddy,
      RUNTIME_RAIDERS_TEST_APPROVED_POLICY: testFixture.approvedPolicy,
      RUNTIME_RAIDERS_TEST_APPROVED_POLICY_LOADER: testFixture.approvedPolicyLoader,
      RUNTIME_RAIDERS_TEST_CADDY_ENV: testFixture.caddyEnv,
      RUNTIME_RAIDERS_TEST_ARTIFACT_ROOT: testFixture.artifactRoot,
      RUNTIME_RAIDERS_TEST_NODE: process.execPath,
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

function replaceAssignmentLine(path: string, key: string, line: string): void {
  const lines = readFileSync(path, 'utf8').split('\n');
  const index = lines.findIndex((candidate) => candidate.startsWith(`${key}=`));
  if (index < 0) throw new Error(`missing fixture assignment: ${key}`);
  lines[index] = line;
  writeFileSync(path, lines.join('\n'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Runtime Raiders Pi preflight', () => {
  it('samples the complete updater hold before every other external readiness observation', () => {
    const result = run(fixture());
    const commands = result.commands.trim().split('\n');
    expect(result.status, result.output).toBe(0);
    expect(commands.slice(0, 3)).toEqual([
      'systemctl is-enabled claude-rpg-autoupdate.timer',
      'systemctl is-active claude-rpg-autoupdate.timer',
      'systemctl is-active claude-rpg-autoupdate.service',
    ]);
  });

  it('stops before mutable readiness observations when the initial updater hold fails', () => {
    const result = run(fixture(), { FAKE_UPDATER_SERVICE_ACTIVE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL systemd units');
    expect(result.commands).not.toContain('git ');
    expect(result.commands).not.toContain('sqlite3 ');
    expect(result.commands).not.toContain('caddy ');
    expect(result.commands).not.toContain('curl ');
  });

  it.each([
    ['HEAD changes', { FAKE_FINAL_LOCAL_SHA: 'c'.repeat(40) }],
    ['worktree becomes dirty', { FAKE_FINAL_GIT_DIRTY: '1' }],
    ['origin/main changes', { FAKE_FINAL_TARGET_SHA: 'c'.repeat(40) }],
    ['ancestry changes', { FAKE_FINAL_GIT_DIVERGED: '1' }],
  ])('rejects a repository whose %s before the final paused-state read', (_name, environment) => {
    const result = run(fixture(), environment);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL final Git readiness');
    expect(result.commands.trim().split('\n').at(-1)).toContain('SELECT paused FROM game_state');
  });

  it('requires local HEAD to equal the explicitly recorded prior SHA', () => {
    const f = fixture();
    f.priorSha = 'c'.repeat(40);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Git readiness');
  });

  it('rejects HEAD equal to the approved release as a partial deployment', () => {
    const result = run(fixture(), { FAKE_LOCAL_SHA: 'b'.repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Git readiness');
  });

  it('requires the already-launched auto-updater service to be inactive', () => {
    const result = run(fixture(), { FAKE_UPDATER_SERVICE_ACTIVE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL systemd units');
  });

  it('fails when the updater service becomes active before READY', () => {
    const result = run(fixture(), {
      FAKE_UPDATER_SERVICE_ACTIVE: '0',
      FAKE_FINAL_UPDATER_SERVICE_ACTIVE: '1',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL final updater hold');
  });

  it.each([
    ['new', { FAKE_NEW_DNS_IP: '198.51.100.20' }],
    ['old', { FAKE_OLD_DNS_IP: '198.51.100.21' }],
  ])('rejects the %s internal FQDN when real DNS omits the local Pi address', (_name, environment) => {
    const result = run(fixture(), environment);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL internal DNS');
  });

  it('validates approved policy objects without release files in the prior checkout', () => {
    const f = fixture();
    rmSync(f.policy);
    rmSync(join(f.repo, 'src/domain/raid-power-policy.ts'));
    const result = run(f);
    expect(result.status, result.output).toBe(0);
  });

  it('rejects an approved policy object that its approved loader rejects', () => {
    const f = fixture();
    const invalidPolicy = {
      ...JSON.parse(readFileSync(f.approvedPolicy, 'utf8')),
      unexpected_release_field: true,
    };
    writeFileSync(f.approvedPolicy, `${JSON.stringify(invalidPolicy)}\n`);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('budgets the approved target tree when it is much larger than the prior checkout', () => {
    const result = run(fixture(), {
      FAKE_TARGET_TREE_BYTES: String(100 * 1024 * 1024),
      FAKE_NODE_MODULES_KB: '100',
      FAKE_FREE_KB: '600000',
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL disk capacity');
  });

  it('disables optional Git locks for every repository inspection', () => {
    const result = run(fixture());
    expect(result.status, result.output).toBe(0);
    const gitCommands = result.commands.split('\n').filter((line) => line.startsWith('git '));
    expect(gitCommands.length).toBeGreaterThan(0);
    expect(gitCommands.every((line) => line.startsWith('git --no-optional-locks -C '))).toBe(true);
  });

  it('leaves a real repository index byte-for-byte and metadata unchanged', () => {
    const f = realGitFixture();
    const tracked = join(f.repo, 'tracked.txt');
    const touched = new Date(statSync(tracked).mtimeMs + 2_000);
    utimesSync(tracked, touched, touched);
    const index = join(f.repo, '.git/index');
    const beforeBytes = readFileSync(index);
    const beforeMtime = statSync(index).mtimeMs;

    const result = run(f);

    expect(result.status, result.output).toBe(0);
    expect(readFileSync(index)).toEqual(beforeBytes);
    expect(statSync(index).mtimeMs).toBe(beforeMtime);
  });

  it('fails disk capacity for a large approved tree absent from the prior checkout', () => {
    const f = realGitFixture(8 * 1024 * 1024);
    expect(existsSync(join(f.repo, 'large-target.bin'))).toBe(false);
    const result = run(f, { FAKE_NODE_MODULES_KB: '100', FAKE_FREE_KB: '530000' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL disk capacity');
  });

  it.each([
    ['admin placeholder', 'ADMIN_PASSWORD', 'change-me-please'],
    ['session placeholder', 'SESSION_SECRET', 'change-me-too'],
    ['empty admin secret', 'ADMIN_PASSWORD', ''],
  ])('rejects a candidate game env with %s', (_name, key, value) => {
    const f = fixture();
    replaceAssignment(f.envFile, key, value);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
    expect(result.output).not.toContain(value || 'top-secret-password');
  });

  it('rejects duplicate secret assignments in the candidate game env', () => {
    const f = fixture();
    writeFileSync(f.envFile, `${readFileSync(f.envFile, 'utf8')}ADMIN_PASSWORD=second-secret\n`);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
    expect(result.output).not.toContain('second-secret');
  });

  it.each([
    ['quoted value', 'ADMIN_PASSWORD="top-secret-password"'],
    ['escaped value', 'ADMIN_PASSWORD=top-secret\\-password'],
    ['leading whitespace', ' ADMIN_PASSWORD=top-secret-password'],
    ['trailing whitespace', 'ADMIN_PASSWORD=top-secret-password '],
  ])('rejects unsupported simple-assignment syntax with %s', (_name, assignment) => {
    const f = fixture();
    replaceAssignmentLine(f.envFile, 'ADMIN_PASSWORD', assignment);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
    expect(result.output).not.toContain('top-secret-password');
  });

  it('rejects a weak candidate game secret', () => {
    const f = fixture();
    replaceAssignment(f.envFile, 'ADMIN_PASSWORD', 'password');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
    expect(result.output).not.toContain('password');
  });

  it('requires the candidate game environment to be root-owned', () => {
    const result = run(fixture(), { FAKE_GAME_ENV_UID: '1000' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL paths');
  });

  it('rejects a candidate game env with group or other permissions', () => {
    const f = fixture();
    chmodSync(f.envFile, 0o644);
    const result = run(f, { FAKE_GAME_ENV_MODE: '644' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL paths');
  });

  it('rejects Caddy paths that differ from the manager-loaded service definition', () => {
    const f = fixture();
    const result = run(f, {
      FAKE_CADDY_LOADED_CONFIG: join(f.root, 'other-Caddyfile'),
      FAKE_CADDY_LOADED_ENV: join(f.root, 'other-caddy.env'),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
  });

  it('requires the manager-loaded Caddy service to be active', () => {
    const result = run(fixture(), { FAKE_CADDY_ACTIVE: '0' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
  });

  it.each([
    ['placeholder', 'replace-with-your-cloudflare-token'],
    ['empty value', ''],
  ])('rejects a Caddy environment with a %s token', (_name, token) => {
    const f = fixture();
    writeFileSync(f.caddyEnv, `CLOUDFLARE_API_TOKEN=${token}\n`);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
    expect(result.output).not.toContain(token || 'top-secret-caddy-token');
  });

  it('rejects a quoted effective Caddy placeholder', () => {
    const f = fixture();
    writeFileSync(f.caddyEnv, 'CLOUDFLARE_API_TOKEN="replace-with-your-cloudflare-token"\n');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
    expect(result.output).not.toContain('replace-with-your-cloudflare-token');
  });

  it('rejects a weak Caddy token', () => {
    const f = fixture();
    writeFileSync(f.caddyEnv, 'CLOUDFLARE_API_TOKEN=tiny\n');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
    expect(result.output).not.toContain('tiny');
  });

  it('requires the Caddy environment to be root-owned', () => {
    const result = run(fixture(), { FAKE_CADDY_ENV_UID: '1000' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL paths');
  });

  it('rejects duplicate Cloudflare token assignments without exposing either token', () => {
    const f = fixture();
    writeFileSync(f.caddyEnv, 'CLOUDFLARE_API_TOKEN=first-secret\nCLOUDFLARE_API_TOKEN=second-secret\n');
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Caddy configuration');
    expect(result.output).not.toContain('first-secret');
    expect(result.output).not.toContain('second-secret');
  });

  it('rejects a Caddy environment with group or other permissions', () => {
    const f = fixture();
    chmodSync(f.caddyEnv, 0o640);
    const result = run(f, { FAKE_CADDY_ENV_MODE: '640' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL paths');
  });

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

  it('rejects a legacy OTEL endpoint assignment without exposing its value', () => {
    const f = fixture();
    writeFileSync(f.envFile, `${readFileSync(f.envFile, 'utf8')}OTEL_ENDPOINT_HOST=legacy-secret-endpoint.invalid\n`);

    const result = run(f);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
    expect(result.output).not.toContain('legacy-secret-endpoint.invalid');
  });

  it('rejects the checked-in placeholder even when supplied as the expected timestamp', () => {
    const f = fixture();
    f.cutoverAt = '1800000000000';
    replaceAssignment(f.envFile, 'RUN_SCORING_CUTOVER_AT', f.cutoverAt);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it.each([
    ['missing', undefined],
    ['nonnumeric', 'garbage'],
    ['wrong compatibility port', '8081'],
  ])('rejects a %s startup port', (_name, value) => {
    const f = fixture();
    replaceAssignment(f.envFile, 'PORT', value);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it.each([
    ['missing username', undefined],
    ['empty username', ''],
    ['unsafe username', 'admin user'],
  ])('rejects a candidate game environment with %s', (_name, value) => {
    const f = fixture();
    replaceAssignment(f.envFile, 'ADMIN_USERNAME', value);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it.each([
    ['missing sprite path', undefined],
    ['wrong sprite path', 'wrong'],
  ])('rejects a candidate game environment with %s', (_name, value) => {
    const f = fixture();
    replaceAssignment(f.envFile, 'SPRITES_DIR', value === 'wrong' ? join(f.repo, 'assets', 'other') : value);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('requires the intended sprite compatibility directory to exist and be readable', () => {
    const f = fixture();
    rmSync(f.spritesDir, { recursive: true });
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL Runtime Raiders environment');
  });

  it('rejects a policy document that the application policy loader rejects', () => {
    const f = fixture();
    const invalidPolicy = {
      ...JSON.parse(readFileSync(f.approvedPolicy, 'utf8')),
      unexpected_release_field: true,
    };
    writeFileSync(f.approvedPolicy, `${JSON.stringify(invalidPolicy)}\n`);
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
    ['approved release policy object', (f: Fixture) => rmSync(f.approvedPolicy), 'FAIL Runtime Raiders environment'],
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
    ['hostname/local-address verification', { FAKE_LOCAL_ADDRESSES: '198.51.100.20' }],
    ['internal DNS verification', { FAKE_NEW_DNS_IP: '198.51.100.20' }],
  ])('does not probe artifact routes when %s fails', (_name, environment) => {
    const result = run(fixture(), environment);
    const artifactRouteRequests = result.commands.split('\n').filter((command) =>
      command.includes('https://raiders.redlattice.com/install.sh') ||
      command.includes('https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'),
    );
    expect(result.status).not.toBe(0);
    expect(artifactRouteRequests).toHaveLength(0);
    expect(result.output).toContain('FAIL artifact routes unpublished');
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

  it('requires a root-owned empty artifact store before cutover', () => {
    const f = fixture();
    symlinkSync('releases/' + 'b'.repeat(40), join(f.artifactRoot, 'current'));
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL artifact store');
  });

  it('rejects missing or symlinked artifact release directories', () => {
    for (const kind of ['missing', 'symlink'] as const) {
      const f = fixture();
      rmSync(join(f.artifactRoot, 'releases'), { recursive: true });
      if (kind === 'symlink') {
        symlinkSync(f.root, join(f.artifactRoot, 'releases'));
      }
      const result = run(f);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('FAIL artifact store');
    }
  });

  it('rejects a permission-widened artifact root', () => {
    const result = run(fixture(), { FAKE_ARTIFACT_ROOT_MODE: '777' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL artifact store');
  });

  it('requires artifact routes to remain unpublished before cutover', () => {
    const result = run(fixture(), { FAKE_ARTIFACT_HTTP_STATUS: '200' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('FAIL artifact routes unpublished');
  });

  it('requires the exact unpublished quartet route set including the public update manifest', () => {
    const result = run(fixture());
    const artifactRouteRequests = result.commands.split('\n').filter((command) =>
      command.startsWith('curl ') && command.includes('https://raiders.redlattice.com/') &&
      !command.includes('/health'),
    );

    expect(result.status, result.output).toBe(0);
    expect(artifactRouteRequests).toHaveLength(4);
    expect(artifactRouteRequests.some((command) =>
      command.endsWith('https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json'),
    )).toBe(true);
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
    expect(result.output).toContain('PASS artifact store');
    expect(result.output).toContain('PASS artifact routes unpublished');
    expect(result.output).toContain('PASS HTTPS new host');
    expect(result.output).toContain('PASS HTTPS old host');
    expect(result.output).toContain('PASS hostname resolution');
    expect(result.output).toContain('PASS systemd units');
    expect(result.output).toContain('PASS disk capacity');
    expect(result.output).not.toContain('top-secret-password');
    expect(result.output).not.toContain('top-secret-session');
    expect(result.output).not.toContain('top-secret-caddy-token');
    expect(result.output.trim().split('\n').at(-1)).toBe('READY separately authorized cutover gates passed');
  });

  it('uses only observed read-only commands and leaves DB, env, and policy fixtures unchanged', () => {
    const f = fixture();
    const protectedFixtures = [
      f.db,
      f.envFile,
      f.policy,
      f.approvedPolicy,
      f.approvedPolicyLoader,
      f.approvedCaddy,
      f.caddyConfig,
      f.caddyEnv,
    ];
    const protectedDirectories = [
      f.artifactRoot,
      join(f.artifactRoot, 'releases'),
    ];
    const before = protectedFixtures.map((path) => readFileSync(path, 'utf8'));
    const beforeDirectoryMetadata = protectedDirectories.map((path) => {
      const metadata = statSync(path);
      return {
        mode: metadata.mode,
        uid: metadata.uid,
        gid: metadata.gid,
        mtimeMs: metadata.mtimeMs,
        entries: readdirSync(path),
      };
    });
    const result = run(f);
    const after = protectedFixtures.map((path) => readFileSync(path, 'utf8'));
    const afterDirectoryMetadata = protectedDirectories.map((path) => {
      const metadata = statSync(path);
      return {
        mode: metadata.mode,
        uid: metadata.uid,
        gid: metadata.gid,
        mtimeMs: metadata.mtimeMs,
        entries: readdirSync(path),
      };
    });

    expect(result.status, result.output).toBe(0);
    expect(after).toEqual(before);
    expect(afterDirectoryMetadata).toEqual(beforeDirectoryMetadata);
    expect(result.commands).toContain('sqlite3 -readonly');
    expect(result.commands).toContain('git --no-optional-locks -C');
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
