import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = join(process.cwd(), 'scripts/pi/runtime-raiders-cutover-guards.sh');
const prior = '1'.repeat(40);
const release = '2'.repeat(40);
const service = 'claude-rpg.service';
const envFile = '/etc/claude-rpg.env';
const execPath = '/srv/runtime-raiders/scripts/pi/run-server.sh';

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-cutover-guards-'));
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
  executable(join(bin, 'sudo'), [
    'if [ "${1:-}" = -u ]; then shift 2; fi',
    'exec "$@"',
  ]);
  executable(join(bin, 'git'), [
    'case "$*" in',
    '  *"rev-parse HEAD"*) [ "$FAKE_HEAD_FAIL" != 1 ] || exit 6; printf "%s\\n" "$FAKE_HEAD";;',
    '  *"rev-parse origin/main"*) [ "$FAKE_ORIGIN_FAIL" != 1 ] || exit 7; printf "%s\\n" "$FAKE_ORIGIN";;',
    '  *"status --porcelain"*) [ "$FAKE_STATUS_FAIL" != 1 ] || exit 8; printf "%s" "$FAKE_STATUS_OUTPUT";;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'find'), [
    '[ "$FAKE_FIND_FAIL" != 1 ] || exit 9',
    'printf "%s" "$FAKE_FIND_OUTPUT"',
  ]);
  executable(join(bin, 'systemctl'), [
    'case "${1:-}" in',
    '  is-enabled)',
    '    printf "%s\\n" "${FAKE_TIMER_ENABLED_VALUE-disabled}"',
    '    exit "${FAKE_TIMER_ENABLED_STATUS:-1}"',
    '    ;;',
    '  is-active)',
    '    case "${2:-}" in',
    '      runtime-raiders.timer)',
    '        printf "%s\\n" "${FAKE_TIMER_ACTIVE_VALUE-inactive}"',
    '        exit "${FAKE_TIMER_ACTIVE_STATUS:-3}"',
    '        ;;',
    '      runtime-raiders.service)',
    '        printf "%s\\n" "${FAKE_UPDATER_ACTIVE_VALUE-inactive}"',
    '        exit "${FAKE_UPDATER_ACTIVE_STATUS:-3}"',
    '        ;;',
    '      *) exit 4 ;;',
    '    esac',
    '    ;;',
    '  show)',
    '    case "$*" in',
    '      *"--property=User --value"*) printf "%s\\n" "${FAKE_UNIT_USER:-rluser}" ;;',
    '      *"--property=WorkingDirectory --value"*) printf "%s\\n" "${FAKE_UNIT_WORKING_DIRECTORY:-$FAKE_REPO}" ;;',
    '      *"--property=EnvironmentFiles --value"*) printf "%s\\n" "${FAKE_UNIT_ENVIRONMENT_FILES:-$FAKE_ENV_FILE (ignore_errors=no)}" ;;',
    '      *"--property=ExecStart --value"*) printf "%s\\n" "${FAKE_UNIT_EXEC_START-$FAKE_RUNNING_EXEC}" ;;',
    '      *) exit 64 ;;',
    '    esac',
    '    exit "${FAKE_SHOW_STATUS:-0}"',
    '    ;;',
    '  *) exit 64 ;;',
    'esac',
  ]);
  const environment = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin:/sbin`,
    FAKE_HEAD: prior,
    FAKE_ORIGIN: release,
    FAKE_STATUS_OUTPUT: '',
    FAKE_FIND_OUTPUT: '',
    FAKE_HEAD_FAIL: '0',
    FAKE_ORIGIN_FAIL: '0',
    FAKE_STATUS_FAIL: '0',
    FAKE_FIND_FAIL: '0',
  };
  return { root, repo, environment };
}

function gameUnitEnvironment(base: NodeJS.ProcessEnv, repo: string) {
  return {
    ...base,
    FAKE_REPO: repo,
    FAKE_ENV_FILE: envFile,
    FAKE_RUNNING_EXEC: `{ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; start_time=[Tue 2026-08-04 10:15:47 EDT] ; stop_time=[n/a] ; pid=71893 ; code=(null) ; status=0/0 }`,
  };
}

function run(repo: string, body: string, environment: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['-c', [
    'set -Eeuo pipefail',
    'source "$1"',
    body,
    'printf "reached\\n"',
  ].join('\n'), 'bash', helper, repo, prior, release], {
    env: environment,
    encoding: 'utf8',
  });
}

function runSystemdGuard(
  repo: string,
  body: string,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync('bash', ['-c', [
    'set -Eeuo pipefail',
    `trap 'printf "unexpected-err:%s\\n" "$BASH_COMMAND" >&2; exit 97' ERR`,
    'source "$1"',
    body,
    'trap - ERR',
    'printf "reached\\n"',
  ].join('\n'), 'bash', helper, repo], {
    env: environment,
    encoding: 'utf8',
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runRollbackAuthentication(
  record: string,
  seal: string,
  expected: string,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync('bash', ['-c', [
    'set -Eeuo pipefail',
    'source "$1"',
    'rr_authenticate_rollback_record "$2" "$3" "$4"',
    'source "$2"',
    'printf "reached\\n"',
  ].join('\n'), 'bash', helper, record, seal, expected], {
    env: environment,
    encoding: 'utf8',
  });
}

describe('Runtime Raiders executable cutover guards', () => {
  it('accepts a clean expected checkout and owner-only repository', () => {
    const { root, repo, environment } = fixture();
    try {
      const result = run(repo, [
        'rr_assert_checkout "$2" "$3" "$4"',
        'rr_assert_owned_tree "$2"',
      ].join('\n'), environment);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('reached\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the cutover guard when git status returns nonzero with no output', () => {
    const { root, repo, environment } = fixture();
    try {
      const result = run(repo, 'rr_assert_checkout "$2" "$3" "$4"', {
        ...environment,
        FAKE_STATUS_FAIL: '1',
      });
      expect(result.status).toBe(8);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the rollback guard when privileged ownership traversal returns no output and fails', () => {
    const { root, repo, environment } = fixture();
    try {
      const result = run(repo, 'rr_assert_owned_tree "$2"', {
        ...environment,
        FAKE_FIND_FAIL: '1',
      });
      expect(result.status).toBe(9);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects successful dirty or foreign-owned probe output', () => {
    const { root, repo, environment } = fixture();
    try {
      const dirty = run(repo, 'rr_assert_checkout "$2" "$3" "$4"', {
        ...environment,
        FAKE_STATUS_OUTPUT: ' M package.json',
      });
      expect(dirty.status).not.toBe(0);
      expect(dirty.stdout).not.toContain('reached');

      const foreign = run(repo, 'rr_assert_owned_tree "$2"', {
        ...environment,
        FAKE_FIND_OUTPUT: `${repo}/root-owned`,
      });
      expect(foreign.status).not.toBe(0);
      expect(foreign.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent record and seal from a different cutover before sourcing', () => {
    const { root, environment } = fixture();
    try {
      const record = join(root, 'rollback-record.sh');
      const seal = join(root, 'rollback-record.sha256');
      const content = 'printf "record-sourced\\n"\n';
      writeFileSync(record, content);
      writeFileSync(seal, `${sha256(content)}\n`);

      const result = runRollbackAuthentication(record, seal, 'a'.repeat(64), environment);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed independently recorded expected hashes before sourcing', () => {
    const { root, environment } = fixture();
    try {
      const record = join(root, 'rollback-record.sh');
      const seal = join(root, 'rollback-record.sha256');
      const content = 'printf "record-sourced\\n"\n';
      const actual = sha256(content);
      writeFileSync(record, content);
      writeFileSync(seal, `${actual}\n`);

      for (const malformed of [actual.slice(1), actual.toUpperCase(), `${actual}0`]) {
        const result = runRollbackAuthentication(record, seal, malformed, environment);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toBe('');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only a record and one-line seal matching the independently recorded hash', () => {
    const { root, environment } = fixture();
    try {
      const record = join(root, 'rollback-record.sh');
      const seal = join(root, 'rollback-record.sha256');
      const content = 'printf "record-sourced\\n"\n';
      const expected = sha256(content);
      writeFileSync(record, content);
      writeFileSync(seal, `${expected}\n`);

      const result = runRollbackAuthentication(record, seal, expected, environment);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('record-sourced\nreached\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an extra-line seal before sourcing the record', () => {
    const { root, environment } = fixture();
    try {
      const record = join(root, 'rollback-record.sh');
      const seal = join(root, 'rollback-record.sha256');
      const content = 'printf "record-sourced\\n"\n';
      const expected = sha256(content);
      writeFileSync(record, content);
      writeFileSync(seal, `${expected}\n${expected}\n`);

      const result = runRollbackAuthentication(record, seal, expected, environment);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts disabled and inactive updater states without invoking inherited ERR', () => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        'rr_assert_updater_held runtime-raiders.timer runtime-raiders.service',
        environment,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('reached\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['enabled timer', { FAKE_TIMER_ENABLED_VALUE: 'enabled', FAKE_TIMER_ENABLED_STATUS: '0' }],
    ['active timer', { FAKE_TIMER_ACTIVE_VALUE: 'active', FAKE_TIMER_ACTIVE_STATUS: '0' }],
    ['failed updater', { FAKE_UPDATER_ACTIVE_VALUE: 'failed', FAKE_UPDATER_ACTIVE_STATUS: '3' }],
    ['unknown updater', { FAKE_UPDATER_ACTIVE_VALUE: 'unknown', FAKE_UPDATER_ACTIVE_STATUS: '4' }],
    ['empty observation', { FAKE_UPDATER_ACTIVE_VALUE: '', FAKE_UPDATER_ACTIVE_STATUS: '3' }],
    ['unexpected systemctl failure', { FAKE_UPDATER_ACTIVE_VALUE: 'inactive', FAKE_UPDATER_ACTIVE_STATUS: '5' }],
  ])('rejects %s', (_label, overrides) => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        'rr_assert_updater_held runtime-raiders.timer runtime-raiders.service',
        { ...environment, ...overrides },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['enabled timer', { FAKE_TIMER_ENABLED_VALUE: 'enabled', FAKE_TIMER_ENABLED_STATUS: '0' }],
    ['active timer', { FAKE_TIMER_ACTIVE_VALUE: 'active', FAKE_TIMER_ACTIVE_STATUS: '0' }],
    ['failed updater', { FAKE_UPDATER_ACTIVE_VALUE: 'failed', FAKE_UPDATER_ACTIVE_STATUS: '3' }],
    ['unknown updater', { FAKE_UPDATER_ACTIVE_VALUE: 'unknown', FAKE_UPDATER_ACTIVE_STATUS: '4' }],
    ['empty observation', { FAKE_UPDATER_ACTIVE_VALUE: '', FAKE_UPDATER_ACTIVE_STATUS: '3' }],
    ['unexpected systemctl failure', { FAKE_TIMER_ENABLED_VALUE: 'disabled', FAKE_TIMER_ENABLED_STATUS: '5' }],
  ])('rejects %s when the updater assertion is used as a predicate', (_label, overrides) => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        'rr_assert_updater_held runtime-raiders.timer runtime-raiders.service || exit 1',
        { ...environment, ...overrides },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['running', `{ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; start_time=[Tue 2026-08-04 10:15:47 EDT] ; stop_time=[n/a] ; pid=71893 ; code=(null) ; status=0/0 }`],
    ['stopped', `{ path=${execPath} ; argv[]=${execPath} ; ignore_errors=no ; start_time=[Tue 2026-08-04 11:42:09 EDT] ; stop_time=[Tue 2026-08-04 12:03:51 EDT] ; pid=93217 ; code=killed ; status=15/TERM }`],
  ])('accepts the stable game unit while %s', (_state, execStart) => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        `rr_assert_game_unit ${service} "$2" ${envFile} ${execPath}`,
        { ...gameUnitEnvironment(environment, repo), FAKE_UNIT_EXEC_START: execStart },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('reached\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['wrong user', { FAKE_UNIT_USER: 'root' }],
    ['wrong working directory', { FAKE_UNIT_WORKING_DIRECTORY: '/srv/wrong' }],
    ['wrong environment', { FAKE_UNIT_ENVIRONMENT_FILES: '/etc/wrong.env (ignore_errors=no)' }],
    ['wrong path', { FAKE_UNIT_EXEC_START: '{ path=/bin/false ; argv[]=/bin/false ; status=0/0 }' }],
    ['missing argv', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; status=0/0 }` }],
    ['duplicate path', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; path=${execPath} ; argv[]=${execPath} ; status=0/0 }` }],
    ['duplicate argv', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; argv[]=${execPath} ; argv[]=${execPath} ; status=0/0 }` }],
    ['extra command', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; argv[]=${execPath} ; } { path=/bin/true ; argv[]=/bin/true ; }` }],
    ['missing record delimiters', { FAKE_UNIT_EXEC_START: `path=${execPath} argv[]=${execPath}` }],
    ['empty show result', { FAKE_UNIT_EXEC_START: '' }],
    ['failed show', { FAKE_SHOW_STATUS: '5' }],
  ])('rejects a game unit with %s', (_label, overrides) => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        `rr_assert_game_unit ${service} "$2" ${envFile} ${execPath}`,
        { ...gameUnitEnvironment(environment, repo), ...overrides },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['unbalanced opening brace', `{ path=${execPath} ; argv[]=${execPath} ; status=0/0 ; { }`],
    ['unbalanced closing brace', `{ path=${execPath} ; argv[]=${execPath} ; status=0/0 ; } }`],
    ['nested record', `{ path=${execPath} ; argv[]=${execPath} ; { status=0/0 ; } }`],
    ['trailing record material', `{ path=${execPath} ; argv[]=${execPath} ; status=0/0 ; } trailing }`],
    ['missing closing delimiter', `{ path=${execPath} ; argv[]=${execPath} ; status=0/0`],
    ['text after closing delimiter', `{ path=${execPath} ; argv[]=${execPath} ; status=0/0 ; } trailing`],
  ])('rejects malformed ExecStart record shape: %s', (_label, execStart) => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        `rr_assert_game_unit ${service} "$2" ${envFile} ${execPath}`,
        { ...gameUnitEnvironment(environment, repo), FAKE_UNIT_EXEC_START: execStart },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['wrong user', { FAKE_UNIT_USER: 'root' }],
    ['wrong working directory', { FAKE_UNIT_WORKING_DIRECTORY: '/srv/wrong' }],
    ['wrong environment', { FAKE_UNIT_ENVIRONMENT_FILES: '/etc/wrong.env (ignore_errors=no)' }],
    ['wrong path', { FAKE_UNIT_EXEC_START: '{ path=/bin/false ; argv[]=/bin/false ; status=0/0 }' }],
    ['missing argv', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; status=0/0 }` }],
    ['duplicate path', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; path=${execPath} ; argv[]=${execPath} ; status=0/0 }` }],
    ['duplicate argv', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; argv[]=${execPath} ; argv[]=${execPath} ; status=0/0 }` }],
    ['extra command', { FAKE_UNIT_EXEC_START: `{ path=${execPath} ; argv[]=${execPath} ; } { path=/bin/true ; argv[]=/bin/true ; }` }],
    ['failed show', { FAKE_SHOW_STATUS: '5' }],
  ])('rejects an invalid game unit used as a predicate: %s', (_label, overrides) => {
    const { root, repo, environment } = fixture();
    try {
      const result = runSystemdGuard(
        repo,
        `if rr_assert_game_unit ${service} "$2" ${envFile} ${execPath}; then exit 0; else exit 1; fi`,
        { ...gameUnitEnvironment(environment, repo), ...overrides },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('reached');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
