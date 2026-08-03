import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = join(process.cwd(), 'scripts/pi/runtime-raiders-cutover-guards.sh');
const prior = '1'.repeat(40);
const release = '2'.repeat(40);

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
  const environment = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
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
});
