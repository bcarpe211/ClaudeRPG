import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const runner = resolve('scripts/test/run-runtime-raiders-live-activation-gate.sh');
const roots: string[] = [];

function executable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
}

function fixture(scenario = 'success') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-raiders-live-gate-')));
  roots.push(root);
  const home = join(root, 'home');
  const sessions = join(home, '.codex', 'sessions');
  const tools = join(root, 'tools');
  const state = join(root, 'state');
  const log = join(root, 'commands.log');
  const remoteRepository = join(root, 'remote-repository');
  const remoteDatabase = join(remoteRepository, 'data', 'claude-rpg.db');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const historyDirectory = join(sessions, 'history');
  mkdirSync(historyDirectory);
  for (let index = 0; index < 816; index += 1) {
    writeFileSync(join(historyDirectory, `history-${index}.jsonl`), '');
  }

  if (scenario === 'remote-query') {
    mkdirSync(dirname(remoteDatabase), { recursive: true });
    const schema = `
      CREATE TABLE game_state (paused INTEGER, last_activity_at INTEGER, combat_active_ms INTEGER);
      INSERT INTO game_state VALUES (1, 100, 200);
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY, provider TEXT, surface TEXT, state TEXT,
        usage_input INTEGER, usage_output INTEGER, usage_cache_read INTEGER,
        usage_cache_write INTEGER, usage_reasoning_output INTEGER,
        awarded_usage_credit INTEGER, awarded_completion_credit INTEGER,
        awarded_duration_credit INTEGER, raid_power INTEGER
      );
      INSERT INTO runs VALUES (1, 'codex', 'codex_desktop', 'completed', 1, 0, 0, 0, 0, 100, 0, 0, 100);
      CREATE TABLE run_events (run_id INTEGER, awarded_delta INTEGER);
      INSERT INTO run_events VALUES (1, 100);
      CREATE TABLE token_events (id INTEGER PRIMARY KEY, effective_delta INTEGER, total_delta INTEGER);
      INSERT INTO token_events VALUES (1, 100, 1000);
      CREATE TABLE players (total_tokens INTEGER, effective_tokens INTEGER, gold INTEGER);
      INSERT INTO players VALUES (1000, 100, 50);
      CREATE TABLE raider_devices (revoked_at INTEGER);
      INSERT INTO raider_devices VALUES (NULL);
    `;
    const sqlite = spawnSync('/usr/bin/sqlite3', [remoteDatabase, schema], { encoding: 'utf8' });
    expect(sqlite.status, sqlite.stderr).toBe(0);
    writeFileSync(join(remoteRepository, 'README'), 'remote fixture\n');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'tests@example.invalid'],
      ['config', 'user.name', 'Runtime Raiders Tests'],
      ['add', 'README'],
      ['commit', '-qm', 'fixture'],
    ]) {
      const git = spawnSync('/usr/bin/git', args, { cwd: remoteRepository, encoding: 'utf8' });
      expect(git.status, git.stderr).toBe(0);
    }
  }

  executable(join(tools, 'raiders'), `
printf 'raiders:%s\n' "${'$'}*" >> '${log}'
case "${'$'}{1:-}" in
  status)
    status_count="${'$'}(/bin/cat '${state}/status-count' 2>/dev/null || printf 0)"
    status_count=${'$'}((status_count + 1))
    printf '%s' "${'$'}status_count" > '${state}/status-count'
    if [ "${'$'}{GATE_SCENARIO:-}" = status-fail ] && [ "${'$'}status_count" -eq 1 ]; then exit 1; fi
    current="${'$'}(/bin/cat '${state}/activation' 2>/dev/null || printf disabled)"
    if [ "${'$'}{GATE_SCENARIO:-}" = initial-enabled ] && [ "${'$'}status_count" -eq 1 ]; then current=ready; fi
    if [ "${'$'}current" = preparing ] && [ "${'$'}{GATE_SCENARIO:-}" = ready-disabled ]; then
      current=disabled
      printf disabled > '${state}/activation'
    elif [ "${'$'}current" = preparing ] && [ "${'$'}{GATE_SCENARIO:-}" = ready-slow ] &&
       [ "${'$'}status_count" -ge 4 ]; then
      current=ready
      printf ready > '${state}/activation'
    elif [ "${'$'}current" = preparing ] &&
       [ "${'$'}{GATE_SCENARIO:-}" != ready-timeout ] &&
       [ "${'$'}{GATE_SCENARIO:-}" != ready-slow ] &&
       [ "${'$'}{GATE_SCENARIO:-}" != signal ]; then
      current=ready
      printf ready > '${state}/activation'
    fi
    if [ "${'$'}current" = disabled ]; then
      printf '{"activationState":"disabled","activeRunCount":0,"daemonRunning":true,"enabled":false,"installedCompanionVersion":"0.4.0","lastSuccessfulUploadMS":null,"persistedState":"disabled","queuedEventCount":0}\n'
    elif [ "${'$'}current" = preparing ]; then
      printf '{"activationState":"preparing","activeRunCount":0,"daemonRunning":true,"enabled":true,"installedCompanionVersion":"0.4.0","lastSuccessfulUploadMS":null,"persistedState":"enabled","queuedEventCount":0}\n'
    else
      printf '{"activationState":"ready","activeRunCount":0,"daemonRunning":true,"enabled":true,"installedCompanionVersion":"0.4.0","lastSuccessfulUploadMS":1700000000000,"persistedState":"enabled","queuedEventCount":0}\n'
    fi
    ;;
  doctor)
    printf '{"codexRootReadable":true,"compatibilityNeedsReview":false,"enrollmentMatchesCompiledAdapters":true,"serverHealthy":true,"signingValid":true}\n'
    ;;
  on)
    printf preparing > '${state}/activation'
    if [ "${'$'}{GATE_SCENARIO:-}" = on-fail ]; then exit 1; fi
    if [ "${'$'}{GATE_SCENARIO:-}" = on-wrong ]; then printf 'ready\n'; else printf 'preparing\n'; fi
    ;;
  off)
    off_count="${'$'}(/bin/cat '${state}/off-count' 2>/dev/null || printf 0)"
    off_count=${'$'}((off_count + 1))
    printf '%s' "${'$'}off_count" > '${state}/off-count'
    if [ "${'$'}{GATE_SCENARIO:-}" = off-retry ] && [ "${'$'}off_count" -eq 1 ]; then exit 1; fi
    if [ "${'$'}{GATE_SCENARIO:-}" = history-drift-off-permanent ]; then exit 1; fi
    printf disabled > '${state}/activation'
    ;;
  *) exit 64 ;;
esac`);

  const baseline = 'ok|1|100|200|4|6066045|4|6|6|13596|164541509|3763464623|13740|13|3763464623|164541509|84005051|1|1';
  const post = 'ok|1|100|200|5|6066947|5|9|9|13598|164542411|3763464623|13742|13|3763464623|164542411|84006020|1|1|1|5|codex|codex_desktop|completed|40|5|0|1|2|48|854|0|902|3|902|1|5|2|902|0';
  const postAfterGameWake = post.replace(
    'ok|1|100|200|',
    'ok|0|1700000001000|250|',
  ).replace('|84006020|1|1|1|5|', '|84004000|1|1|1|5|');
  const historyDrift = baseline.replace('|4|6066045|', '|5|6066045|');
  const volatileActivity = baseline.replace('|1|100|200|', '|1|101|200|');
  const scoreMismatch = post.replace('|902|3|902|', '|903|3|902|');
  executable(join(tools, 'ssh'), `
printf 'ssh:%s\n' "${'$'}*" >> '${log}'
count="${'$'}(/bin/cat '${state}/ssh-count' 2>/dev/null || printf 0)"
count=${'$'}((count + 1))
printf '%s' "${'$'}count" > '${state}/ssh-count'
if [ "${'$'}{GATE_SCENARIO:-}" = remote-query ]; then
  original='${state}/remote-snapshot-original'
  runnable='${state}/remote-snapshot-runnable'
  /bin/cat > "${'$'}original"
  /usr/bin/sed \
    -e "s#repository=/home/rluser/ClaudeRPG#repository='${remoteRepository}'#" \
    -e '\\#/usr/bin/systemctl is-active --quiet#d' \
    "${'$'}original" > "${'$'}runnable"
  values=()
  after_marker=0
  for argument in "${'$'}@"; do
    if [ "${'$'}after_marker" -eq 1 ]; then values+=("${'$'}argument")
    elif [ "${'$'}argument" = -- ]; then after_marker=1
    fi
  done
  [ "${'$'}{#values[@]}" -eq 3 ]
  if [ "${'$'}count" -eq 3 ]; then
    /usr/bin/sqlite3 '${remoteDatabase}' "
      INSERT INTO runs VALUES (2, 'codex', 'codex_desktop', 'completed', 40, 5, 0, 1, 2, 48, 854, 0, 902);
      INSERT INTO run_events VALUES (2, 0), (2, 48), (2, 854);
      INSERT INTO token_events VALUES (2, 48, 0), (3, 854, 0);
      UPDATE players SET effective_tokens = effective_tokens + 902;
    "
  fi
  /bin/bash "${'$'}runnable" "${'$'}{values[@]}"
  exit
fi
case "${'$'}{GATE_SCENARIO:-success}:${'$'}count" in
  history-drift:2) printf '%s\n' '${historyDrift}' ;;
  history-drift-off-permanent:2) printf '%s\n' '${historyDrift}' ;;
  volatile-activity:2) printf '%s\n' '${volatileActivity}' ;;
  game-wake:3) printf '%s\n' '${postAfterGameWake}' ;;
  score-mismatch:3) printf '%s\n' '${scoreMismatch}' ;;
  *:3) printf '%s\n' '${post}' ;;
  *) printf '%s\n' '${baseline}' ;;
esac`);
  executable(join(tools, 'codesign'), `printf 'codesign:%s\n' "${'$'}*" >> '${log}'`);
  executable(join(tools, 'spctl'), `printf 'spctl:%s\n' "${'$'}*" >> '${log}'`);
  executable(join(tools, 'sleep'), `
printf 'sleep:%s\n' "${'$'}*" >> '${log}'
if [ "${'$'}{GATE_SCENARIO:-}" = signal-quiet ]; then
  /bin/kill -TERM "${'$'}PPID"
fi
if [ "${'$'}{GATE_SCENARIO:-}" = quiet-drift ] && [ ! -e '${state}/quiet-drifted' ]; then
  printf drift > '${historyDirectory}/history-0.jsonl'
  : > '${state}/quiet-drifted'
fi
if [ "${'$'}{GATE_SCENARIO:-}" = signal ] && [ "${'$'}(/bin/cat '${state}/activation' 2>/dev/null || true)" = preparing ]; then
  /bin/kill -TERM "${'$'}PPID"
fi`);

  return {
    root,
    home,
    sessions,
    log,
    env: {
      ...process.env,
      HOME: home,
      GATE_SCENARIO: scenario,
      RUNTIME_RAIDERS_LIVE_GATE_TEST_MODE: '1',
      RUNTIME_RAIDERS_LIVE_GATE_TEST_ROOT: resolve('.'),
      RUNTIME_RAIDERS_LIVE_GATE_TEST_RAIDERS: join(tools, 'raiders'),
      RUNTIME_RAIDERS_LIVE_GATE_TEST_SSH: join(tools, 'ssh'),
      RUNTIME_RAIDERS_LIVE_GATE_TEST_CODESIGN: join(tools, 'codesign'),
      RUNTIME_RAIDERS_LIVE_GATE_TEST_SPCTL: join(tools, 'spctl'),
      RUNTIME_RAIDERS_LIVE_GATE_TEST_SLEEP: join(tools, 'sleep'),
      RUNTIME_RAIDERS_LIVE_GATE_TEST_REPORT_ROOT: root,
      RUNTIME_RAIDERS_LIVE_GATE_TEST_READY_ATTEMPTS: '3',
      RUNTIME_RAIDERS_LIVE_GATE_TEST_UPLOAD_ATTEMPTS: '3',
    },
  };
}

function runGate(value: ReturnType<typeof fixture>) {
  return spawnSync('/bin/bash', [runner], {
    cwd: resolve('.'),
    env: value.env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function report(value: ReturnType<typeof fixture>): string {
  const reports = readdirSync(value.root).filter((name) => name.startsWith('runtime-raiders-activation-gate-'));
  expect(reports).toHaveLength(1);
  const reportPath = join(value.root, reports[0]);
  expect((statSync(reportPath).mode & 0o777)).toBe(0o600);
  return readFileSync(reportPath, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Runtime Raiders one-shot live activation gate', () => {
  it('documents the one command, Codex-quiet prerequisite, report, and automatic shutdown', () => {
    const runbook = readFileSync(resolve('docs/runtime-raiders/employee-beta.md'), 'utf8');

    expect(runbook).toContain('/bin/bash scripts/test/run-runtime-raiders-live-activation-gate.sh');
    expect(runbook).toMatch(/quit Codex completely/i);
    expect(runbook).toMatch(/always runs `raiders off`/i);
    expect(runbook).toMatch(/\/private\/tmp\/runtime-raiders-activation-gate-/);
  });

  it('proves a quiet history, one matching scored Run, cleanup, and shutdown', () => {
    const value = fixture();
    const result = runGate(value);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('PASS: exactly one synthetic Runtime Raiders Run was scored');
    const gateReport = report(value);
    expect(gateReport).toContain('result=PASS');
    for (const field of [
      'baseline_token_events=', 'baseline_token_effective=', 'baseline_token_total=',
      'baseline_player_effective=', 'baseline_player_total=',
    ]) expect(gateReport).toContain(field);
    const commands = readFileSync(value.log, 'utf8');
    expect(commands).toMatch(/raiders:on[\s\S]*raiders:off/);
    expect(commands).toContain('rluser@raiders.redlattice.com');
    expect(commands).toContain('ProxyCommand=\/usr\/bin\/nc -b en0 %h %p');
    expect(commands).not.toMatch(/10\.1\.6\./);
    expect(gateReport).not.toMatch(/device[_ -]?token|enrollment|\.jsonl|turn_id/i);
    expect(readdirSync(value.sessions).some((name) => name.startsWith('.runtime-raiders-gate-'))).toBe(false);
  });

  it('executes the streamed remote Bash and SQLite snapshot instead of mocking its output', () => {
    const value = fixture('remote-query');
    const result = runGate(value);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(report(value)).toContain('exactly_one_scored_run=PASS');
    expect(readFileSync(value.log, 'utf8')).not.toContain('SELECT "ok"');
    const streamed = readFileSync(join(value.root, 'state', 'remote-snapshot-original'), 'utf8');
    expect(streamed).toContain('baseline_query=\'SELECT "ok"');
    expect(streamed).toContain('repository=/home/rluser/ClaudeRPG');
    expect(streamed.match(/systemctl is-active --quiet/g)).toHaveLength(2);
  });

  it('records content-free evidence when readiness takes multiple observations', () => {
    const value = fixture('ready-slow');
    const result = runGate(value);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const gateReport = report(value);
    expect(gateReport).toContain('readiness_attempts=3');
    expect(gateReport).toContain('readiness_preparing_observations=2');
    expect(gateReport).toContain('readiness_last_state=ready');
    expect(gateReport).not.toMatch(/device[_ -]?token|enrollment|\.jsonl|turn_id/i);
  });

  it('ignores only the volatile game activity timestamp during the pre-fixture history check', () => {
    const value = fixture('volatile-activity');
    const result = runGate(value);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(report(value)).toContain('history_only_activation=PASS');
  });

  it('accepts exact telemetry scoring when the synthetic activity wakes the game', () => {
    const value = fixture('game-wake');
    const result = runGate(value);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const gateReport = report(value);
    expect(gateReport).toContain('exactly_one_scored_run=PASS');
    expect(gateReport).toContain('baseline_game_paused=1');
    expect(gateReport).toContain('baseline_game_last_activity_at=100');
    expect(gateReport).toContain('baseline_combat_active_ms=200');
    expect(gateReport).toContain('baseline_player_gold=84005051');
    expect(gateReport).toContain('post_game_paused=0');
    expect(gateReport).toContain('post_game_last_activity_at=1700000001000');
    expect(gateReport).toContain('post_combat_active_ms=250');
    expect(gateReport).toContain('post_player_gold=84004000');
  });

  it('retries emergency shutdown until status proves collection is disabled', () => {
    const value = fixture('off-retry');
    const result = runGate(value);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const gateReport = report(value);
    expect(gateReport).toContain('shutdown_attempts=2');
    expect(gateReport).toContain('shutdown=PASS');
    expect(readFileSync(value.log, 'utf8').match(/raiders:off/g)).toHaveLength(2);
  });

  it('reports the gate failure separately when bounded emergency shutdown also fails', () => {
    const value = fixture('history-drift-off-permanent');
    const result = runGate(value);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('server history changed before the synthetic Run');
    const gateReport = report(value);
    expect(gateReport).toContain('failure=server history changed before the synthetic Run');
    expect(gateReport).toContain('shutdown=FAIL');
    expect(gateReport).toContain('shutdown_failure=emergency shutdown could not prove collection is off');
    expect(readFileSync(value.log, 'utf8').match(/raiders:off/g)).toHaveLength(10);
  });

  it('fails immediately and records when the daemon disables itself during preparation', () => {
    const value = fixture('ready-disabled');
    const result = runGate(value);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('agent disabled itself while preparing');
    const gateReport = report(value);
    expect(gateReport).toContain('readiness_attempts=1');
    expect(gateReport).toContain('readiness_preparing_observations=0');
    expect(gateReport).toContain('readiness_last_state=disabled');
    const commands = readFileSync(value.log, 'utf8');
    expect(commands.match(/raiders:status/g)).toHaveLength(3);
    expect(commands).toContain('raiders:off');
  });

  it.each([
    ['quiet-drift', 'provider history changed during the quiet window'],
    ['initial-enabled', 'collection was not disabled at the start'],
    ['status-fail', 'raiders status failed'],
    ['history-drift', 'server history changed before the synthetic Run'],
    ['ready-timeout', 'agent did not become ready'],
    ['on-fail', 'raiders on failed'],
    ['on-wrong', 'raiders on did not return preparing'],
    ['score-mismatch', 'synthetic Run scoring did not reconcile'],
    ['signal', 'interrupted by termination'],
    ['signal-quiet', 'interrupted by termination'],
  ])('fails closed for %s and leaves collection off', (scenario, message) => {
    const value = fixture(scenario);
    const result = runGate(value);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
    const commands = readFileSync(value.log, 'utf8');
    if (['quiet-drift', 'initial-enabled', 'status-fail', 'signal-quiet'].includes(scenario)) {
      expect(commands).not.toContain('raiders:on');
    }
    expect(commands).toContain('raiders:off');
    expect(readdirSync(value.sessions).some((name) => name.startsWith('.runtime-raiders-gate-'))).toBe(false);
  });
});
