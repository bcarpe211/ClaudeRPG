import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installerTemplate = join(process.cwd(), 'companion/packaging/install.sh');
const label = 'com.redlattice.runtime-raiders-agent';
const version = '1.2.3';
const teamId = 'ABCDE12345';
const enrollmentCode = 'E'.repeat(43);
const token = 'T'.repeat(43);
const secret = 'a'.repeat(64);
const roots: string[] = [];

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o700);
}

function plist(bundleVersion = version, bundleId = label): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>CFBundleIdentifier</key><string>${bundleId}</string>`,
    '<key>CFBundleExecutable</key><string>runtime-raiders-agent</string>',
    `<key>CFBundleShortVersionString</key><string>${bundleVersion}</string>`,
    '</dict></plist>',
    '',
  ].join('\n');
}

function enrollment(): string {
  return JSON.stringify({
    version: 1,
    device_id: '00000000-0000-4000-8000-000000000001',
    device_token: token,
    dedupe_secret: secret,
    server_url: 'https://raiders.redlattice.com',
    cutover_at: 1_800_000_000_000,
    enabled_surfaces: ['codex_desktop', 'codex_cli'],
  }) + '\n';
}

function fakeTools(root: string): string {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  executable(join(bin, 'curl'), [
    'output=""; url=""',
    'printf "curl-argv" >> "$RR_ARGV_LOG"',
    'for argument in "$@"; do printf " <%s>" "$argument" >> "$RR_ARGV_LOG"; done',
    'printf "\\n" >> "$RR_ARGV_LOG"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o|--output) output="$2"; shift 2;;',
    '    -w|--write-out|-X|-H|--data-binary|--proto|--proto-redir|--max-redirs|--connect-timeout|--max-time|--max-filesize) shift 2;;',
    '    --fail|--silent|--show-error|-f|-s|-S|-L) shift;;',
    '    https://*) url="$1"; shift;;',
    '    *) shift;;',
    '  esac',
    'done',
    'case "$url" in',
    '  https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip)',
    '    printf "curl:archive\\n" >> "$RR_EVENT_LOG"',
    '    [ "${RR_FAIL_ARCHIVE_DOWNLOAD:-0}" != 1 ] || exit 56',
    '    cp "$RR_ARCHIVE" "$output"; printf 200;;',
    '  https://raiders.redlattice.com/api/raiders/enroll)',
    '    printf "curl:enroll\\n" >> "$RR_EVENT_LOG"',
    '    cat > "$RR_ENROLL_STDIN"',
    '    [ "${RR_FAIL_ENROLLMENT:-0}" != 1 ] || exit 56',
    '    cp "$RR_ENROLL_RESPONSE" "$output"; printf 201;;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'ditto'), [
    'printf "ditto:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    'if [ "${1:-}" = -x ] && [ "${2:-}" = -k ]; then',
    '  destination="$4"; mkdir -p "$destination"; cp -R "$RR_ARCHIVE_TREE/." "$destination/"',
    'elif [ "$#" -eq 2 ]; then',
    '  cp -R "$1" "$2"',
    'else',
    '  exit 64',
    'fi',
  ]);
  executable(join(bin, 'codesign'), [
    'printf "codesign-argv" >> "$RR_ARGV_LOG"',
    'for argument in "$@"; do printf " <%s>" "$argument" >> "$RR_ARGV_LOG"; done',
    'printf "\\n" >> "$RR_ARGV_LOG"',
    '[ "${RR_FAIL_SIGNATURE:-0}" != 1 ] || exit 1',
    'if [ "$#" -eq 5 ] && [ "$1" = --verify ] && [ "$2" = --deep ] && [ "$3" = --strict ] && [ "$4" = --verbose=2 ]; then',
    '  printf "codesign:deep\\n" >> "$RR_EVENT_LOG"; exit 0',
    'fi',
    'if [ "$#" -eq 5 ] && [ "$1" = --verify ] && [ "$2" = --strict ] && [ "$3" = -R ]; then',
    '  printf "%s" "$4" | grep -F "identifier \\"com.redlattice.runtime-raiders-agent\\"" >/dev/null',
    '  printf "%s" "$4" | grep -F "certificate leaf[subject.OU] = \\"$RR_TEAM_ID\\"" >/dev/null',
    '  printf "codesign:requirement\\n" >> "$RR_EVENT_LOG"; exit 0',
    'fi',
    'exit 64',
  ]);
  executable(join(bin, 'spctl'), [
    '[ "$#" -eq 5 ] && [ "$1" = --assess ] && [ "$2" = --type ] && [ "$3" = execute ] && [ "$4" = --verbose=2 ] || exit 64',
    '[ "${RR_FAIL_SPCTL:-0}" != 1 ] || exit 1',
    'printf "spctl:assess\\n" >> "$RR_EVENT_LOG"',
  ]);
  executable(join(bin, 'launchctl'), [
    'printf "launchctl:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    'case "${1:-}" in',
    '  bootout) rm -f "$RR_RUNNING"; exit 0;;',
    '  bootstrap)',
    '    if [ "${RR_FAIL_FIRST_BOOTSTRAP:-0}" = 1 ] && [ ! -e "$RR_BOOTSTRAP_FAILED" ]; then',
    '      : > "$RR_BOOTSTRAP_FAILED"; exit 75',
    '    fi',
    '    : > "$RR_RUNNING"; exit 0;;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'stty'), [
    'printf "tty:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    '[ "${1:-}" != -g ] || printf saved',
  ]);
  executable(join(bin, 'uuidgen'), ['printf "00000000-0000-4000-8000-000000000001\\n"']);
  return bin;
}

type Fixture = ReturnType<typeof fixture>;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-beta-installer-'));
  roots.push(root);
  const home = join(root, 'home');
  const support = join(home, 'Library/Application Support/Runtime Raiders');
  const state = join(support, 'state');
  const outbox = join(support, 'outbox');
  const app = join(support, 'Runtime Raiders Agent.app');
  const plistPath = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const shim = join(support, 'raiders');
  const command = join(home, '.local/bin/raiders');
  const archiveTree = join(root, 'archive-tree');
  const candidate = join(archiveTree, 'Runtime Raiders Agent.app');
  const eventLog = join(root, 'events.log');
  const argvLog = join(root, 'argv.log');
  const enrollmentStdin = join(root, 'enrollment-stdin.json');
  const running = join(root, 'running');
  const archive = join(root, 'runtime-raiders-agent.zip');
  const enrollmentResponse = join(root, 'enrollment-response.json');
  const tty = join(root, 'tty');
  mkdirSync(join(candidate, 'Contents/MacOS'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(candidate, 'Contents/Info.plist'), plist());
  executable(join(candidate, 'Contents/MacOS/runtime-raiders-agent'), [
    'printf "agent:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    '[ "${RR_FAIL_STATUS:-0}" != 1 ] || exit 78',
    '[ "${1:-status}" = status ] || [ "${1:-}" = daemon ] || exit 64',
    'printf "candidate-status\\n"',
  ]);
  writeFileSync(archive, 'fake archive bytes\n');
  writeFileSync(enrollmentResponse, JSON.stringify({
    device_token: token,
    dedupe_secret: secret,
    server_url: 'https://raiders.redlattice.com',
    cutover_at: 1_800_000_000_000,
    enabled_surfaces: ['codex_desktop', 'codex_cli'],
  }) + '\n');
  writeFileSync(tty, `${enrollmentCode}\n`);
  writeFileSync(eventLog, '');
  writeFileSync(argvLog, '');
  const bin = fakeTools(root);
  return {
    root, home, support, state, outbox, app, plist: plistPath, shim, command,
    candidate, eventLog, argvLog, enrollmentStdin, running,
    environment: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      RR_ARCHIVE: archive,
      RR_ARCHIVE_TREE: archiveTree,
      RR_ENROLL_RESPONSE: enrollmentResponse,
      RR_ENROLL_STDIN: enrollmentStdin,
      RR_EVENT_LOG: eventLog,
      RR_ARGV_LOG: argvLog,
      RR_RUNNING: running,
      RR_BOOTSTRAP_FAILED: join(root, 'bootstrap-failed'),
      RR_TEAM_ID: teamId,
      RR_TTY: tty,
      RR_FAKE_BIN: bin,
    } as NodeJS.ProcessEnv,
  };
}

function renderInstaller(value: Fixture): string {
  const fake = value.environment.RR_FAKE_BIN!;
  const tty = value.environment.RR_TTY!;
  const rendered = join(value.root, 'install-rendered.sh');
  const validator = join(value.root, 'old-validator');
  executable(validator, ['exit 0']);
  const source = readFileSync(installerTemplate, 'utf8')
    .replaceAll('__RUNTIME_RAIDERS_COMPANION_VERSION__', version)
    .replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', teamId)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SEQUENCE__', '16')
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SHA__', 'b'.repeat(40))
    .replaceAll('__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__', '2')
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__', 'c'.repeat(64))
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__', readFileSync(validator).toString('base64'))
    .replaceAll('/usr/bin/curl', join(fake, 'curl'))
    .replaceAll('/usr/bin/ditto', join(fake, 'ditto'))
    .replaceAll('/usr/bin/codesign', join(fake, 'codesign'))
    .replaceAll('/usr/sbin/spctl', join(fake, 'spctl'))
    .replaceAll('/bin/launchctl', join(fake, 'launchctl'))
    .replaceAll('/usr/bin/stty', join(fake, 'stty'))
    .replaceAll('/usr/bin/uuidgen', join(fake, 'uuidgen'))
    .replaceAll('/dev/tty', tty);
  writeFileSync(rendered, source, { mode: 0o700 });
  return rendered;
}

function run(value: Fixture, shell = '/bin/sh') {
  return spawnSync(shell, [renderInstaller(value)], {
    env: value.environment,
    encoding: 'utf8',
  });
}

function writeExistingInstall(value: Fixture, enabled: boolean): void {
  mkdirSync(join(value.app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(value.home, 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(value.state, { recursive: true });
  mkdirSync(value.outbox, { recursive: true });
  mkdirSync(join(value.home, '.local/bin'), { recursive: true });
  writeFileSync(join(value.app, 'Contents/Info.plist'), plist('0.9.0'));
  executable(join(value.app, 'Contents/MacOS/runtime-raiders-agent'), ['printf "old-status\\n"']);
  writeFileSync(value.plist, 'old plist bytes\n', { mode: 0o600 });
  executable(value.shim, ['printf "old shim\\n"']);
  symlinkSync(value.shim, value.command);
  writeFileSync(join(value.state, 'enrollment.json'), enrollment(), { mode: 0o600 });
  writeFileSync(
    join(value.state, 'collector-state.json'),
    `{"enabled":${enabled},"files":{"opaque":"preserve"},"version":1}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(value.state, 'opaque-state.bin'), Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  writeFileSync(join(value.outbox, 'event.json'), '{"opaque":"queued"}\n', { mode: 0o600 });
  writeFileSync(value.running, 'old daemon running\n');
}

function treeSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(root)) return result;
  const visit = (path: string): void => {
    const info = lstatSync(path);
    const key = relative(root, path) || '.';
    if (info.isSymbolicLink()) {
      result[key] = `L:${readlinkSync(path)}`;
      return;
    }
    if (info.isDirectory()) {
      result[key] = `D:${info.mode & 0o777}`;
      for (const child of readdirSync(path).sort()) visit(join(path, child));
      return;
    }
    result[key] = `F:${info.mode & 0o777}:${readFileSync(path).toString('base64')}`;
  };
  visit(root);
  return result;
}

function events(value: Fixture): string[] {
  return readFileSync(value.eventLog, 'utf8').trim().split('\n').filter(Boolean);
}

function expectNoBootout(value: Fixture): void {
  expect(events(value).some((line) => line.startsWith('launchctl:bootout '))).toBe(false);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Runtime Raiders reinstall-safe installer', () => {
  it('fresh install starts off through absent state and enrolls once', () => {
    const value = fixture();
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(existsSync(join(value.state, 'collector-state.json'))).toBe(false);
    expect(events(value).filter((line) => line === 'curl:enroll')).toHaveLength(1);
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).toBe(enrollment());
  });

  it('reinstall reuses valid enrollment without asking for a code', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
    expect(events(value)).not.toContain('curl:enroll');
  });

  it.each([false, true])('reinstall preserves state, outbox, and enabled=%s byte-for-byte', (enabled) => {
    const value = fixture();
    writeExistingInstall(value, enabled);
    const stateBefore = treeSnapshot(value.state);
    const outboxBefore = treeSnapshot(value.outbox);
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(treeSnapshot(value.outbox)).toEqual(outboxBefore);
    expect(events(value).some((line) => line.includes('agent:off'))).toBe(false);
  });

  it('verifies archive identity and Apple trust before prompt or bootout', () => {
    const value = fixture();
    const result = run(value);
    const log = events(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(log.indexOf('codesign:deep')).toBeLessThan(log.indexOf('codesign:requirement'));
    expect(log.indexOf('codesign:requirement')).toBeLessThan(log.indexOf('spctl:assess'));
    expect(log.indexOf('spctl:assess')).toBeLessThan(log.findIndex((line) => line.startsWith('tty:')));
    expect(log.indexOf('spctl:assess')).toBeLessThan(log.findIndex((line) => line.startsWith('launchctl:bootout ')));
  });

  it.each([
    ['bad signature', (value: Fixture) => { value.environment.RR_FAIL_SIGNATURE = '1'; }],
    ['bad Gatekeeper assessment', (value: Fixture) => { value.environment.RR_FAIL_SPCTL = '1'; }],
    ['wrong bundle ID', (value: Fixture) => {
      writeFileSync(join(value.candidate, 'Contents/Info.plist'), plist(version, 'example.invalid'));
    }],
    ['wrong version', (value: Fixture) => {
      writeFileSync(join(value.candidate, 'Contents/Info.plist'), plist('9.9.9'));
    }],
    ['missing executable', (value: Fixture) => {
      rmSync(join(value.candidate, 'Contents/MacOS/runtime-raiders-agent'));
    }],
    ['extra top-level archive entry', (value: Fixture) => {
      writeFileSync(join(value.root, 'archive-tree/extra.txt'), 'extra\n');
    }],
    ['archive metadata directory', (value: Fixture) => {
      mkdirSync(join(value.root, 'archive-tree/__MACOSX'));
    }],
    ['archive symlink', (value: Fixture) => {
      symlinkSync('/tmp', join(value.candidate, 'Contents/link'));
    }],
  ] as const)('%s never stops the current daemon', (_, mutate) => {
    const value = fixture();
    writeExistingInstall(value, false);
    mutate(value);
    const result = run(value);
    expect(result.status).not.toBe(0);
    expectNoBootout(value);
    expect(readFileSync(value.running, 'utf8')).toBe('old daemon running\n');
  });

  it('success replaces app, plist, and shim and restarts exactly once', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(join(value.app, 'Contents/Info.plist'), 'utf8')).toBe(plist());
    expect(readFileSync(value.plist, 'utf8')).toContain(join(value.app, 'Contents/MacOS/runtime-raiders-agent'));
    expect(readFileSync(value.shim, 'utf8')).not.toContain('old shim');
    expect(events(value).filter((line) => line.startsWith('launchctl:bootstrap '))).toHaveLength(1);
    expect(existsSync(value.running)).toBe(true);
  });

  it('a post-stop failure restores the old app, plist, and shim and restarts it', () => {
    const value = fixture();
    writeExistingInstall(value, true);
    const appBefore = treeSnapshot(value.app);
    const plistBefore = readFileSync(value.plist);
    const shimBefore = readFileSync(value.shim);
    value.environment.RR_FAIL_FIRST_BOOTSTRAP = '1';
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.app)).toEqual(appBefore);
    expect(readFileSync(value.plist)).toEqual(plistBefore);
    expect(readFileSync(value.shim)).toEqual(shimBefore);
    expect(events(value).filter((line) => line.startsWith('launchctl:bootstrap '))).toHaveLength(2);
    expect(existsSync(value.running)).toBe(true);
  });

  it('the canonical command executes the flat stable app executable', () => {
    const value = fixture();
    const installed = run(value);
    expect(installed.status, installed.stderr + installed.stdout).toBe(0);
    const invoked = spawnSync(value.command, ['status'], { env: value.environment, encoding: 'utf8' });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stdout).toBe('candidate-status\n');
    expect(readFileSync(value.shim, 'utf8')).not.toContain('launcher');
  });

  it.each(['support', 'state', 'outbox', 'app', 'plist', 'shim'] as const)('rejects a symlinked %s path', (kind) => {
    const value = fixture();
    const outside = join(value.root, 'outside');
    mkdirSync(outside);
    if (kind === 'support') {
      mkdirSync(join(value.home, 'Library/Application Support'), { recursive: true });
      symlinkSync(outside, value.support);
    } else {
      mkdirSync(kind === 'plist' ? join(value.home, 'Library/LaunchAgents') : value.support, { recursive: true });
      const target = kind === 'state' ? value.state
        : kind === 'outbox' ? value.outbox
          : kind === 'app' ? value.app
            : kind === 'plist' ? value.plist
              : value.shim;
      symlinkSync(outside, target);
    }
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refuses symlinked path');
    expectNoBootout(value);
  });

  it('creates no versioned updater or prepared-command layout', () => {
    const value = fixture();
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    for (const absent of [
      'launcher', 'releases', 'installation/release-state.json', 'installation/update-journal.json',
      'state/prepared-startup.lock', 'state/prepared-command',
    ]) expect(existsSync(join(value.support, absent))).toBe(false);
    expect(events(value).join('\n')).not.toMatch(/sequence|prepared|launcher/);
  });

  it('refuses the private sequence-16 layout with fresh-canary cleanup guidance', () => {
    const value = fixture();
    mkdirSync(join(value.support, `releases/sequence-16-${'b'.repeat(40)}`), { recursive: true });
    const before = treeSnapshot(value.support);
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/sequence-16.*fresh canary.*cleanup/i);
    expect(treeSnapshot(value.support)).toEqual(before);
    expectNoBootout(value);
  });

  it.each(['/bin/sh', '/bin/zsh'])('%s parses and executes the rendered installer', (shell) => {
    const value = fixture();
    const rendered = renderInstaller(value);
    const parsed = spawnSync(shell, ['-n', rendered], { encoding: 'utf8' });
    expect(parsed.status, parsed.stderr).toBe(0);
    const result = spawnSync(shell, [rendered], { env: value.environment, encoding: 'utf8' });
    expect(result.status, result.stderr + result.stdout).toBe(0);
  });

  it('keeps the enrollment code out of argv, output, logs, and installed files', () => {
    const value = fixture();
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(value.enrollmentStdin, 'utf8')).toContain(enrollmentCode);
    expect(`${result.stdout}${result.stderr}`).not.toContain(enrollmentCode);
    expect(readFileSync(value.argvLog, 'utf8')).not.toContain(enrollmentCode);
    expect(readFileSync(value.eventLog, 'utf8')).not.toContain(enrollmentCode);
    expect(JSON.stringify(treeSnapshot(value.home))).not.toContain(Buffer.from(enrollmentCode).toString('base64'));
  });

  it('an archive network failure leaves the existing install running and unchanged', () => {
    const value = fixture();
    writeExistingInstall(value, true);
    const before = treeSnapshot(value.home);
    value.environment.RR_FAIL_ARCHIVE_DOWNLOAD = '1';
    const result = run(value);
    expect(result.status).not.toBe(0);
    expectNoBootout(value);
    expect(existsSync(value.running)).toBe(true);
    expect(treeSnapshot(value.home)).toEqual(before);
  });

  it('is idempotent across repeated execution and enrolls only once', () => {
    const value = fixture();
    const first = run(value);
    const stateAfterFirst = treeSnapshot(value.state);
    const outboxAfterFirst = treeSnapshot(value.outbox);
    const second = run(value);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(treeSnapshot(value.state)).toEqual(stateAfterFirst);
    expect(treeSnapshot(value.outbox)).toEqual(outboxAfterFirst);
    expect(events(value).filter((line) => line === 'curl:enroll')).toHaveLength(1);
    expect(existsSync(value.running)).toBe(true);
  });
});
