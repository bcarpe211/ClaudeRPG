import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = join(process.cwd(), 'companion/packaging/install.sh');
const build = join(process.cwd(), 'scripts/release/build-runtime-raiders-agent.sh');
const label = 'com.redlattice.runtime-raiders-agent';
const token = 'A'.repeat(43);
const secret = 'b'.repeat(64);
const enrollmentCode = 'c'.repeat(43);
const teamId = 'ABCDE12345';

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o755);
}

function renderedInstaller(root: string): string {
  const path = join(root, 'install.sh');
  writeFileSync(path, readFileSync(installer, 'utf8').replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', teamId));
  chmodSync(path, 0o755);
  return path;
}

function artifact(root: string, marker = 'initial'): { zip: string; checksum: string } {
  const stage = join(root, 'stage');
  const app = join(stage, 'Runtime Raiders Agent.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  executable(join(app, 'Contents/MacOS/runtime-raiders-agent'), [
    '# ' + marker,
    'printf "%s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_BINARY_LOG"',
  ]);
  writeFileSync(join(app, 'Contents/Info.plist'), '<plist version="1.0"><dict/></plist>');
  const zip = join(root, 'runtime-raiders-agent.zip');
  execFileSync('zip', ['-qry', zip, 'Runtime Raiders Agent.app'], { cwd: stage });
  const checksum = join(root, 'runtime-raiders-agent.zip.sha256');
  writeFileSync(checksum, 'a'.repeat(64) + '  runtime-raiders-agent.zip\n');
  return { zip, checksum };
}

function fakes(root: string): string {
  const bin = join(root, 'fakes');
  mkdirSync(bin, { recursive: true });
  executable(join(bin, 'curl'), [
    'printf "curl %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    'output=""',
    'last=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then output="$2"; shift 2; continue; fi',
    '  if [ "$1" = "-w" ]; then shift 2; continue; fi',
    '  if [ "$1" = "--data" ]; then printf "request %s\\n" "$2" >> "$RUNTIME_RAIDERS_TEST_LOG"; shift 2; continue; fi',
    '  last="$1"; shift',
    'done',
    'case "$last" in',
    '  */runtime-raiders-agent.zip) cp "$RUNTIME_RAIDERS_TEST_ZIP" "$output";;',
    '  */runtime-raiders-agent.zip.sha256) cp "$RUNTIME_RAIDERS_TEST_CHECKSUM" "$output";;',
    '  */api/raiders/enroll) printf "%s" "$RUNTIME_RAIDERS_TEST_ENROLLMENT" > "$output"; printf "201";;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'shasum'), [
    'if [ "$FAKE_SHASUM_FAIL" = 1 ]; then exit 1; fi',
    'last=""; for argument in "$@"; do last="$argument"; done',
    'printf "' + 'a'.repeat(64) + '  %s\\n" "$last"',
  ]);
  executable(join(bin, 'codesign'), [
    'printf "codesign %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    'verify=0; requirement=0',
    'for argument in "$@"; do [ "$argument" = "--verify" ] && verify=1; [ "$argument" = "-R" ] && exit 65; case "$argument" in -R=*) printf "%s\\n" "$argument" | grep -F "identifier \\"com.redlattice.runtime-raiders-agent\\"" >/dev/null && requirement=1;; esac; done',
    '[ "$verify" = 0 ] || [ "$requirement" = 1 ]',
    '[ "$FAKE_CODESIGN_FAIL" != 1 ]',
  ]);
  executable(join(bin, 'ln'), [
    '[ "$FAKE_LN_FAIL" != 1 ] || exit 76',
    'exec /bin/ln "$@"',
  ]);
  executable(join(bin, 'chmod'), [
    'case "$2" in */path-marker-owned) [ "$FAKE_CHMOD_FAIL_MARKER" != 1 ] || exit 75;; esac',
    'exec /bin/chmod "$@"',
  ]);
  executable(join(bin, 'launchctl'), [
    'if [ "$1" = print ]; then',
    '  [ "$FAKE_LAUNCH_PRINT_PRESENT" = 1 ] && exit 0',
    '  [ "$FAKE_LAUNCH_PRINT_ABSENT" = 1 ] && { printf "Could not find service\\n" >&2; exit 113; }',
    '  printf "launchctl print ambiguous failure\\n" >&2; exit 77',
    'fi',
    'if [ "$1" = bootout ] && [ "$FAKE_LAUNCH_BOOTOUT_FAIL" = 1 ]; then printf "bootout ambiguous failure\\n" >&2; exit 77; fi',
    'if [ "$1" = bootstrap ] && [ "$FAKE_LAUNCH_BOOTSTRAP_FAIL" = 1 ]; then printf "bootstrap failure\\n" >&2; exit 77; fi',
    'printf "launchctl %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
  ]);
  executable(join(bin, 'uuidgen'), ['printf "%s\\n" "00000000-0000-4000-8000-000000000001"']);
  executable(join(bin, 'plutil'), [
    'case "$2" in',
    'device_token) printf "%s\\n" "' + token + '";;',
    'dedupe_secret) printf "%s\\n" "' + secret + '";;',
    'server_url) printf "%s\\n" "https://raiders.redlattice.com";;',
    'cutover_at) printf "%s\\n" "1700000000000";;',
    'enabled_surfaces) printf "%s\\n" "[\\"codex_desktop\\",\\"codex_cli\\"]";;',
    '*) exit 64;; esac',
  ]);
  for (const command of ['sudo', 'brew', 'port', 'npm', 'pip', 'pip3']) {
    executable(join(bin, command), [
      'printf "banned ' + command + ' %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
      'exit 97',
    ]);
  }
  return bin;
}

function env(home: string, fake: string, files: { zip: string; checksum: string }, path = ''): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PATH: (path ? path + ':' + fake : fake) + ':/usr/bin:/bin',
    FAKE_SHASUM_FAIL: '0',
    FAKE_CODESIGN_FAIL: '0',
    FAKE_LN_FAIL: '0',
    FAKE_CHMOD_FAIL_MARKER: '0',
    FAKE_LAUNCH_PRINT_PRESENT: '0',
    FAKE_LAUNCH_PRINT_ABSENT: '1',
    FAKE_LAUNCH_BOOTOUT_FAIL: '0',
    FAKE_LAUNCH_BOOTSTRAP_FAIL: '0',
    RUNTIME_RAIDERS_TEST_LOG: join(home, 'commands.log'),
    RUNTIME_RAIDERS_TEST_BINARY_LOG: join(home, 'binary.log'),
    RUNTIME_RAIDERS_TEST_ZIP: files.zip,
    RUNTIME_RAIDERS_TEST_CHECKSUM: files.checksum,
    RUNTIME_RAIDERS_TEST_ENROLLMENT: JSON.stringify({
      device_token: token, dedupe_secret: secret, server_url: 'https://raiders.redlattice.com',
      cutover_at: 1700000000000, enabled_surfaces: ['codex_desktop', 'codex_cli'],
    }),
  };
}

function invoke(file: string, args: string[], environment: NodeJS.ProcessEnv) {
  return spawnSync('bash', [file, ...args], { env: environment, encoding: 'utf8' });
}

describe('Runtime Raiders companion installer', () => {
  it('installs only verified files, preserves private state on upgrade, and never spends a second code', () => {
    // Catches replacement-before-verification, enrollment re-consumption, and provider mutations.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-installer-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const sentinels = ['.codex', '.claude', '.omp'];
      for (const name of sentinels) {
        mkdirSync(join(home, name), { recursive: true });
        writeFileSync(join(home, name, 'untouched'), name);
      }
      const files = artifact(root);
      const environment = env(home, fakes(root), files, commandDir);
      const first = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(first.status, first.stderr).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const state = join(support, 'state');
      const config = join(state, 'enrollment.json');
      const plist = join(home, 'Library/LaunchAgents', label + '.plist');
      expect(statSync(support).mode & 0o777).toBe(0o700);
      expect(statSync(state).mode & 0o777).toBe(0o700);
      expect(statSync(config).mode & 0o777).toBe(0o600);
      expect(statSync(join(support, 'raiders')).mode & 0o777).toBe(0o700);
      expect(existsSync(join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'))).toBe(true);
      expect(lstatSync(join(commandDir, 'raiders')).isSymbolicLink()).toBe(true);
      expect(readFileSync(plist, 'utf8')).toContain('<string>' + label + '</string>');
      expect(readFileSync(plist, 'utf8')).toContain('Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent');
      expect(readFileSync(plist, 'utf8')).not.toContain(token);
      expect(readFileSync(plist, 'utf8')).not.toContain(secret);
      expect(readFileSync(plist, 'utf8')).not.toContain('first-code');
      for (const name of sentinels) {
        expect(readFileSync(join(home, name, 'untouched'), 'utf8')).toBe(name);
      }
      mkdirSync(join(support, 'outbox'), { recursive: true });
      writeFileSync(join(state, 'cursor.json'), 'cursor');
      writeFileSync(join(support, 'outbox', 'event.json'), 'event');
      const second = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(join(state, 'cursor.json'), 'utf8')).toBe('cursor');
      expect(readFileSync(join(support, 'outbox', 'event.json'), 'utf8')).toBe('event');
      const log = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(log.match(/api\/raiders\/enroll/g)).toHaveLength(1);
      expect(log).toContain('request {"code":"' + enrollmentCode + '","device_id":"00000000-0000-4000-8000-000000000001","companion_version":"0.1.0"}');
      expect(log).toContain('launchctl bootstrap gui/' + (process.getuid?.() ?? 0) + ' ' + plist);
      expect(log).not.toContain('banned ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([['checksum', { FAKE_SHASUM_FAIL: '1' }], ['signature', { FAKE_CODESIGN_FAIL: '1' }]])(
    'does not replace or enroll when %s verification fails',
    (_name, extra) => {
      // Catches an installer that consumes a one-time enrollment before artifact trust is established.
      const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-verification-'));
      try {
        const home = join(root, 'home');
        const environment = { ...env(home, fakes(root), artifact(root)), ...extra };
        const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
        expect(result.status).not.toBe(0);
        expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app'))).toBe(false);
        expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders/state/enrollment.json'))).toBe(false);
        const log = existsSync(join(home, 'commands.log')) ? readFileSync(join(home, 'commands.log'), 'utf8') : '';
        expect(log).not.toContain('/api/raiders/enroll');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('works when the documented one-line installer is piped directly to sh', () => {
    // Catches a package installer that depends on files beside its downloaded script.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-piped-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = env(home, fakes(root), artifact(root), commandDir);
      const result = spawnSync('/bin/sh', ['-s', '--', '--code', enrollmentCode], {
        env: environment,
        input: readFileSync(renderedInstaller(root), 'utf8'),
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(home, 'Library/LaunchAgents', label + '.plist'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one marked fallback PATH line and its owner-only shim safely uninstalls', () => {
    // Catches profile-clobbering uninstall and a shim that skips the daemon persisted-off command.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-uninstall-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const fake = fakes(root);
      chmodSync(fake, 0o555);
      const environment = env(home, fake, artifact(root));
      const profile = join(home, '.zprofile');
      writeFileSync(profile, '# before\nexport OTHER=1\n# after\n');
      const install = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(install.status, install.stderr).toBe(0);
      const marker = 'export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path';
      expect(readFileSync(profile, 'utf8')).toBe('# before\nexport OTHER=1\n# after\n' + marker + '\n');
      const command = join(home, '.local/bin/raiders');
      expect(lstatSync(command).isSymbolicLink()).toBe(true);
      const reinstall = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(reinstall.status, reinstall.stderr).toBe(0);
      expect(readFileSync(profile, 'utf8')).toBe('# before\nexport OTHER=1\n# after\n' + marker + '\n');
      const uninstall = spawnSync(command, ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(readFileSync(join(home, 'binary.log'), 'utf8')).toContain('uninstall');
      expect(readFileSync(join(home, 'commands.log'), 'utf8'))
        .toContain('launchctl bootout gui/' + (process.getuid?.() ?? 0));
      expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders'))).toBe(false);
      expect(existsSync(command)).toBe(false);
      expect(readFileSync(profile, 'utf8')).toBe('# before\nexport OTHER=1\n# after\n');
    } finally {
      chmodSync(join(root, 'fakes'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never removes a recorded command path after it no longer points to the owned shim', () => {
    // Catches uninstall deleting a user-replaced PATH entry from stale installer state.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-link-tamper-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = env(home, fakes(root), artifact(root), commandDir);
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], environment).status).toBe(0);
      const command = join(commandDir, 'raiders');
      const replacement = join(root, 'user-command');
      executable(replacement, ['exit 0']);
      unlinkSync(command);
      symlinkSync(replacement, command);
      const shim = join(home, 'Library/Application Support/Runtime Raiders/raiders');
      const uninstall = spawnSync(shim, ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(lstatSync(command).isSymbolicLink()).toBe(true);
      expect(readFileSync(replacement, 'utf8')).toContain('exit 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses cleanup after a failed stop while the launchd job is still present', () => {
    // Catches a protocol or permission failure being misclassified as an absent daemon.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-live-job-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = { ...env(home, fakes(root), artifact(root), commandDir), FAKE_LAUNCH_PRINT_PRESENT: '1' };
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], environment).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      executable(join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'), ['exit 23']);
      const shim = join(support, 'raiders');
      const uninstall = spawnSync(shim, ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status).not.toBe(0);
      expect(existsSync(support)).toBe(true);
      expect(lstatSync(join(commandDir, 'raiders')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses cleanup when bootout is ambiguous even after the binary stops cleanly', () => {
    // Catches an uninstall race that removes files before launchd has released the job.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-bootout-ambiguity-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = { ...env(home, fakes(root), artifact(root), commandDir), FAKE_LAUNCH_BOOTOUT_FAIL: '1' };
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], environment).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const shim = join(support, 'raiders');
      const uninstall = spawnSync(shim, ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status).not.toBe(0);
      expect(existsSync(support)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses failed-stop cleanup when launchctl print is ambiguous', () => {
    // Catches permission/domain/protocol errors treated as a definitive absent job.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-print-ambiguity-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = { ...env(home, fakes(root), artifact(root), commandDir), FAKE_LAUNCH_PRINT_ABSENT: '0' };
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], environment).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      executable(join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'), ['exit 23']);
      const uninstall = spawnSync(join(support, 'raiders'), ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status).not.toBe(0);
      expect(existsSync(support)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('permits fallback cleanup only when both failed stop and definitive launchd absence are proven', () => {
    // Catches an over-strict uninstall that leaves a genuinely absent service undeletable.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-absent-fallback-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = env(home, fakes(root), artifact(root), commandDir);
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], environment).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      executable(join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'), ['exit 23']);
      const uninstall = spawnSync(join(support, 'raiders'), ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(existsSync(support)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-wire-safe enrollment code before any download or exchange', () => {
    // Catches JSON injection into the enrollment request.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-code-validation-'));
    try {
      const home = join(root, 'home');
      const environment = env(home, fakes(root), artifact(root));
      const result = invoke(renderedInstaller(root), ['--code', 'bad"code'], environment);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(home, 'commands.log'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the checked-in installer has no rendered Team ID', () => {
    // Catches an installer that accepts ad-hoc or unrelated valid code signatures.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-unrendered-'));
    try {
      const home = join(root, 'home');
      const environment = env(home, fakes(root), artifact(root));
      const result = invoke(installer, ['--code', enrollmentCode], environment);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(home, 'commands.log'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins the rendered installer to the exact Developer ID designated requirement', () => {
    // Catches verification that checks only structural signing and not the trusted signer.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-requirement-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = { ...env(home, fakes(root), artifact(root), commandDir), RUNTIME_RAIDERS_TEAM_ID: 'WRONGTEAM' };
      const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(result.status, result.stderr).toBe(0);
      const log = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(log).toContain('codesign --verify --strict -R=identifier');
      expect(log).toContain('identifier "com.redlattice.runtime-raiders-agent"');
      expect(log).toContain('subject.OU] = "' + teamId + '"');
      expect(log).not.toContain('WRONGTEAM');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preflights a command conflict before downloading or spending an enrollment code', () => {
    // Catches a conflict discovered after an irreversible enrollment exchange.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-conflict-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      writeFileSync(join(commandDir, 'raiders'), 'user command');
      const environment = env(home, fakes(root), artifact(root), commandDir);
      const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(commandDir, 'raiders'), 'utf8')).toBe('user command');
      expect(existsSync(join(home, 'commands.log'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back an existing app, plist, shim, link, and enrollment when bootstrap fails', () => {
    // Catches a failed upgrade leaving the companion half-replaced or unavailable.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-bootstrap-rollback-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root), commandDir);
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], base).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const appBinary = join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent');
      const plist = join(home, 'Library/LaunchAgents', label + '.plist');
      const shim = join(support, 'raiders');
      const config = join(support, 'state/enrollment.json');
      const command = join(commandDir, 'raiders');
      const before = [readFileSync(appBinary, 'utf8'), readFileSync(plist, 'utf8'), readFileSync(shim, 'utf8'), readFileSync(config, 'utf8'), readFileSync(join(support, 'state/command-link'), 'utf8'), readFileSync(command)];
      const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], {
        ...base, ...env(home, join(root, 'fakes'), artifact(root, 'replacement'), commandDir), FAKE_LAUNCH_BOOTSTRAP_FAIL: '1',
      });
      expect(result.status).not.toBe(0);
      expect([readFileSync(appBinary, 'utf8'), readFileSync(plist, 'utf8'), readFileSync(shim, 'utf8'), readFileSync(config, 'utf8'), readFileSync(join(support, 'state/command-link'), 'utf8'), readFileSync(command)]).toEqual(before);
      expect(lstatSync(command).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back every replaced install surface when link creation fails after backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-link-rollback-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root), commandDir);
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], base).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const plist = join(home, 'Library/LaunchAgents', label + '.plist');
      const command = join(commandDir, 'raiders');
      const files = [
        join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'),
        plist, join(support, 'raiders'), join(support, 'state/enrollment.json'), join(support, 'state/command-link'),
      ];
      const before = files.map((file) => readFileSync(file, 'utf8'));
      const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], {
        ...base, ...env(home, join(root, 'fakes'), artifact(root, 'replacement'), commandDir), FAKE_LN_FAIL: '1',
      });
      expect(result.status).not.toBe(0);
      expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(before);
      expect(readlinkSync(command)).toBe(join(support, 'raiders'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a newly issued enrollment after bootstrap failure and reuses it on retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-fresh-bootstrap-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root), commandDir);
      const first = invoke(renderedInstaller(root), ['--code', enrollmentCode], { ...base, FAKE_LAUNCH_BOOTSTRAP_FAIL: '1' });
      expect(first.status).not.toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      expect(existsSync(join(support, 'state/enrollment.json'))).toBe(true);
      expect(existsSync(join(support, 'Runtime Raiders Agent.app'))).toBe(false);
      expect(existsSync(join(home, 'Library/LaunchAgents', label + '.plist'))).toBe(false);
      expect(existsSync(join(support, 'raiders'))).toBe(false);
      expect(existsSync(join(commandDir, 'raiders'))).toBe(false);
      expect(existsSync(join(support, 'state/command-link'))).toBe(false);
      const retry = invoke(renderedInstaller(root), ['--code', enrollmentCode], base);
      expect(retry.status, retry.stderr).toBe(0);
      expect(readFileSync(join(home, 'commands.log'), 'utf8').match(/api\/raiders\/enroll/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates only an owned recorded command link and preserves user replacements on rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-command-migration-'));
    try {
      const home = join(root, 'home');
      const oldDir = join(home, 'old-bin');
      const newDir = join(home, 'new-bin');
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root), oldDir);
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], base).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const oldCommand = join(oldDir, 'raiders');
      unlinkSync(oldCommand);
      writeFileSync(oldCommand, 'user replacement');
      const newEnvironment = env(home, join(root, 'fakes'), artifact(root, 'replacement'), newDir);
      const failed = invoke(renderedInstaller(root), ['--code', enrollmentCode], { ...newEnvironment, FAKE_LAUNCH_BOOTSTRAP_FAIL: '1' });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(oldCommand, 'utf8')).toBe('user replacement');
      expect(readFileSync(join(support, 'state/command-link'), 'utf8')).toBe(oldCommand + '\n');
      const upgraded = invoke(renderedInstaller(root), ['--code', enrollmentCode], newEnvironment);
      expect(upgraded.status, upgraded.stderr).toBe(0);
      expect(readFileSync(oldCommand, 'utf8')).toBe('user replacement');
      expect(readFileSync(join(support, 'state/command-link'), 'utf8')).toBe(join(newDir, 'raiders') + '\n');
      expect(readlinkSync(join(newDir, 'raiders'))).toBe(join(support, 'raiders'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores a fallback shell profile exactly when a post-marker link step fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-profile-rollback-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const fake = fakes(root);
      chmodSync(fake, 0o555);
      const profile = join(home, '.zprofile');
      writeFileSync(profile, '# user profile\nexport KEEP=1\n');
      const environment = { ...env(home, fake, artifact(root)), FAKE_CHMOD_FAIL_MARKER: '1' };
      const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(result.status).not.toBe(0);
      expect(readFileSync(profile, 'utf8')).toBe('# user profile\nexport KEEP=1\n');
      expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders/state/path-marker-owned'))).toBe(false);
    } finally {
      chmodSync(join(root, 'fakes'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a relative writable PATH entry and records an absolute command link', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-relative-path-'));
    try {
      const home = join(root, 'home');
      const relative = join(root, 'relative');
      const commandDir = join(root, 'absolute-bin');
      mkdirSync(relative, { recursive: true });
      mkdirSync(commandDir, { recursive: true });
      const fake = fakes(root);
      const environment = env(home, fake, artifact(root), 'relative:' + commandDir);
      const result = spawnSync('bash', [renderedInstaller(root), '--code', enrollmentCode], {
        cwd: root, env: environment, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(relative, 'raiders'))).toBe(false);
      const record = readFileSync(join(home, 'Library/Application Support/Runtime Raiders/state/command-link'), 'utf8').trim();
      expect(record).toBe(join(commandDir, 'raiders'));
      expect(record.startsWith('/')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked owned-path component without changing its unrelated target', () => {
    // Catches a recursive installer write through an attacker-controlled support symlink.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-symlink-'));
    try {
      const home = join(root, 'home');
      const outside = join(root, 'outside');
      mkdirSync(join(home, 'Library'), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'sentinel'), 'untouched');
      symlinkSync(outside, join(home, 'Library/Application Support'));
      const environment = env(home, fakes(root), artifact(root));
      const result = invoke(renderedInstaller(root), ['--code', enrollmentCode], environment);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
      expect(existsSync(join(outside, 'Runtime Raiders'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a pre-existing identical PATH marker because it does not own that line', () => {
    // Catches uninstall deleting a user-authored line that happens to match the marker.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-marker-owner-'));
    try {
      const home = join(root, 'home');
      const fake = fakes(root);
      chmodSync(fake, 0o555);
      mkdirSync(home, { recursive: true });
      const profile = join(home, '.zprofile');
      const marker = 'export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path';
      writeFileSync(profile, '# before\n' + marker + '\n# after\n');
      const environment = env(home, fake, artifact(root));
      expect(invoke(renderedInstaller(root), ['--code', enrollmentCode], environment).status).toBe(0);
      const shim = join(home, 'Library/Application Support/Runtime Raiders/raiders');
      expect(spawnSync(shim, ['uninstall'], { env: environment, encoding: 'utf8' }).status).toBe(0);
      expect(readFileSync(profile, 'utf8')).toBe('# before\n' + marker + '\n# after\n');
    } finally {
      chmodSync(join(root, 'fakes'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Runtime Raiders release build', () => {
  it('requires signing and a narrowly scoped notary profile before creating output', () => {
    // Catches a release script that produces an unsigned or unnotarized artifact.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-'));
    try {
      const output = join(root, 'output');
      const result = invoke(build, ['--output', output], { ...process.env, RUNTIME_RAIDERS_CODESIGN_IDENTITY: '', RUNTIME_RAIDERS_TEAM_ID: '' });
      expect(result.status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds, signs, notarizes, staples, rezips, and checksums a universal app without publishing', () => {
    // Catches a release that skips one architecture, a trust step, or publication isolation.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-flow-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const log = join(root, 'commands.log');
      executable(join(fake, 'swift'), [
        'arch=""',
        'while [ "$#" -gt 0 ]; do if [ "$1" = "--arch" ]; then arch="$2"; shift 2; else shift; fi; done',
        'mkdir -p "$PWD/.build/$arch-apple-macosx/release"',
        'printf "%s" "$arch" > "$PWD/.build/$arch-apple-macosx/release/raiders"',
        'printf "swift %s\\n" "$arch" >> "$RUNTIME_RAIDERS_TEST_LOG"',
      ]);
      executable(join(fake, 'lipo'), [
        'output=""',
        'while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done',
        'printf "universal" > "$output"',
        'printf "lipo\\n" >> "$RUNTIME_RAIDERS_TEST_LOG"',
      ]);
      executable(join(fake, 'codesign'), [
        'printf "codesign %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'verify=0; requirement=0',
        'for argument in "$@"; do [ "$argument" = "--verify" ] && verify=1; [ "$argument" = "-R" ] && exit 65; case "$argument" in -R=*) printf "%s\\n" "$argument" | grep -F "identifier \\"com.redlattice.runtime-raiders-agent\\"" >/dev/null && requirement=1;; esac; done',
        '[ "$verify" = 0 ] || [ "$requirement" = 1 ]',
      ]);
      executable(join(fake, 'ditto'), [
        'last=""; for argument in "$@"; do last="$argument"; done',
        'printf x > "$last"',
        'printf "ditto %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
      ]);
      executable(join(fake, 'xcrun'), ['printf "xcrun %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"']);
      executable(join(fake, 'shasum'), [
        'if [ "$FAKE_RELEASE_SHASUM_FAIL" = 1 ]; then exit 1; fi',
        'printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"',
      ]);
      const output = join(root, 'output');
      const result = invoke(build, ['--output', output], {
        ...process.env,
        PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_TEST_LOG: log,
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
        FAKE_RELEASE_SHASUM_FAIL: '0',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip'))).toBe(true);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip.sha256'))).toBe(true);
      expect(readFileSync(join(output, 'install.sh'), 'utf8')).toContain("TEAM_ID='" + teamId + "'");
      const commands = readFileSync(log, 'utf8');
      expect(commands).toContain('swift arm64');
      expect(commands).toContain('swift x86_64');
      expect(commands).toContain('lipo');
      expect(commands).toContain('codesign --force --options runtime --timestamp');
      expect(commands).toContain('codesign --verify --strict');
      expect(commands).toContain('codesign --verify --strict --verbose=2 -R=identifier "com.redlattice.runtime-raiders-agent"');
      expect(commands).toContain('xcrun notarytool submit');
      expect(commands).toContain('--wait');
      expect(commands).toContain('xcrun stapler staple');
      expect(commands).toContain('xcrun stapler validate');
      expect(commands).not.toMatch(/upload|publish|aws|s3|rsync|scp/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a previous artifact pair and rendered installer when final staging fails', () => {
    // Catches release staging that leaves users with a partial ZIP/checksum/installer set.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-rollback-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const log = join(root, 'commands.log');
      executable(join(fake, 'swift'), [
        'arch=""',
        'while [ "$#" -gt 0 ]; do if [ "$1" = "--arch" ]; then arch="$2"; shift 2; else shift; fi; done',
        'mkdir -p "$PWD/.build/$arch-apple-macosx/release"',
        'printf "%s" "$arch" > "$PWD/.build/$arch-apple-macosx/release/raiders"',
      ]);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['last=""; for argument in "$@"; do last="$argument"; done; printf x > "$last"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['exit 1']);
      const output = join(root, 'output');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'runtime-raiders-agent.zip'), 'old zip');
      writeFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'old checksum');
      writeFileSync(join(output, 'install.sh'), 'old installer');
      const result = invoke(build, ['--output', output], {
        ...process.env, PATH: fake + ':/usr/bin:/bin', RUNTIME_RAIDERS_TEST_LOG: log,
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip'), 'utf8')).toBe('old zip');
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'utf8')).toBe('old checksum');
      expect(readFileSync(join(output, 'install.sh'), 'utf8')).toBe('old installer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores output files after an injected replacement failure and preserves an orphan installer', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-output-transaction-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      executable(join(fake, 'swift'), [
        'arch=""; while [ "$#" -gt 0 ]; do if [ "$1" = "--arch" ]; then arch="$2"; shift 2; else shift; fi; done',
        'mkdir -p "$PWD/.build/$arch-apple-macosx/release"; printf "%s" "$arch" > "$PWD/.build/$arch-apple-macosx/release/raiders"',
      ]);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['last=""; for argument in "$@"; do last="$argument"; done; printf x > "$last"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      executable(join(fake, 'mv'), [
        'printf "%s -> %s\\n" "$1" "$2" >> "$RUNTIME_RAIDERS_TEST_MV_LOG"',
        '[ "$FAKE_MV_FAIL" = 1 ] && [ "$2" = "$RUNTIME_RAIDERS_TEST_OUTPUT/runtime-raiders-agent.zip.sha256" ] && exit 79',
        'exec /bin/mv "$@"',
      ]);
      const common = {
        ...process.env, PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
      };
      const output = join(root, 'output');
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'runtime-raiders-agent.zip'), 'old zip');
      writeFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'old checksum');
      writeFileSync(join(output, 'install.sh'), 'old installer');
      const moved = join(root, 'moves.log');
      const failed = invoke(build, ['--output', output], {
        ...common, RUNTIME_RAIDERS_TEST_OUTPUT: output, RUNTIME_RAIDERS_TEST_MV_LOG: moved, FAKE_MV_FAIL: '1',
      });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip'), 'utf8')).toBe('old zip');
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'utf8')).toBe('old checksum');
      expect(readFileSync(join(output, 'install.sh'), 'utf8')).toBe('old installer');
      const finalZipMove = readFileSync(moved, 'utf8').split('\n')
        .find((line) => line.endsWith(' -> ' + join(output, 'runtime-raiders-agent.zip')));
      expect(finalZipMove?.startsWith(output + '/.runtime-raiders-transaction.')).toBe(true);
      const orphan = join(root, 'orphan');
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, 'install.sh'), 'user installer');
      const orphanFailed = invoke(build, ['--output', orphan], {
        ...common, RUNTIME_RAIDERS_TEST_OUTPUT: orphan, RUNTIME_RAIDERS_TEST_MV_LOG: moved, FAKE_MV_FAIL: '1',
      });
      expect(orphanFailed.status).not.toBe(0);
      expect(readFileSync(join(orphan, 'install.sh'), 'utf8')).toBe('user installer');
      expect(existsSync(join(orphan, 'runtime-raiders-agent.zip'))).toBe(false);
      const directoryTarget = join(root, 'directory-target');
      mkdirSync(join(directoryTarget, 'install.sh'), { recursive: true });
      writeFileSync(join(directoryTarget, 'install.sh', 'sentinel'), 'keep');
      const directoryResult = invoke(build, ['--output', directoryTarget], {
        ...common, RUNTIME_RAIDERS_TEST_OUTPUT: directoryTarget, RUNTIME_RAIDERS_TEST_MV_LOG: moved, FAKE_MV_FAIL: '0',
      });
      expect(directoryResult.status).not.toBe(0);
      expect(readFileSync(join(directoryTarget, 'install.sh', 'sentinel'), 'utf8')).toBe('keep');
      expect(existsSync(join(directoryTarget, 'runtime-raiders-agent.zip'))).toBe(false);
      const symlinkTarget = join(root, 'symlink-target');
      const outsideInstaller = join(root, 'outside-installer');
      mkdirSync(symlinkTarget, { recursive: true });
      writeFileSync(outsideInstaller, 'outside');
      symlinkSync(outsideInstaller, join(symlinkTarget, 'install.sh'));
      const symlinkResult = invoke(build, ['--output', symlinkTarget], {
        ...common, RUNTIME_RAIDERS_TEST_OUTPUT: symlinkTarget, RUNTIME_RAIDERS_TEST_MV_LOG: moved, FAKE_MV_FAIL: '0',
      });
      expect(symlinkResult.status).not.toBe(0);
      expect(lstatSync(join(symlinkTarget, 'install.sh')).isSymbolicLink()).toBe(true);
      expect(readFileSync(outsideInstaller, 'utf8')).toBe('outside');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
