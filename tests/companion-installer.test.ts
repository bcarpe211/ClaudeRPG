import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = join(process.cwd(), 'companion/packaging/install.sh');
const build = join(process.cwd(), 'scripts/release/build-runtime-raiders-agent.sh');
const label = 'com.redlattice.runtime-raiders-agent';
const token = 'A'.repeat(43);
const secret = 'b'.repeat(64);
const enrollmentCode = 'c'.repeat(43);

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o755);
}

function artifact(root: string): { zip: string; checksum: string } {
  const stage = join(root, 'stage');
  const app = join(stage, 'Runtime Raiders Agent.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  executable(join(app, 'Contents/MacOS/runtime-raiders-agent'), [
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
    '[ "$FAKE_CODESIGN_FAIL" != 1 ]',
  ]);
  executable(join(bin, 'launchctl'), [
    'if [ "$1" = print ]; then [ "$FAKE_LAUNCH_PRINT_PRESENT" = 1 ] && exit 0; exit 1; fi',
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
    FAKE_LAUNCH_PRINT_PRESENT: '0',
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
      const first = invoke(installer, ['--code', enrollmentCode], environment);
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
      const second = invoke(installer, ['--code', enrollmentCode], environment);
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
        const result = invoke(installer, ['--code', enrollmentCode], environment);
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
      const result = spawnSync('bash', ['-s', '--', '--code', enrollmentCode], {
        env: environment,
        input: readFileSync(installer, 'utf8'),
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
      const install = invoke(installer, ['--code', enrollmentCode], environment);
      expect(install.status, install.stderr).toBe(0);
      const marker = 'export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path';
      expect(readFileSync(profile, 'utf8')).toBe('# before\nexport OTHER=1\n# after\n' + marker + '\n');
      const command = join(home, '.local/bin/raiders');
      expect(lstatSync(command).isSymbolicLink()).toBe(true);
      const reinstall = invoke(installer, ['--code', enrollmentCode], environment);
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
      expect(invoke(installer, ['--code', enrollmentCode], environment).status).toBe(0);
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
      expect(invoke(installer, ['--code', enrollmentCode], environment).status).toBe(0);
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

  it('rejects a non-wire-safe enrollment code before any download or exchange', () => {
    // Catches JSON injection into the enrollment request.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-code-validation-'));
    try {
      const home = join(root, 'home');
      const environment = env(home, fakes(root), artifact(root));
      const result = invoke(installer, ['--code', 'bad"code'], environment);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(home, 'commands.log'))).toBe(false);
    } finally {
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
      const result = invoke(build, ['--output', output], { ...process.env, RUNTIME_RAIDERS_CODESIGN_IDENTITY: '' });
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
      executable(join(fake, 'codesign'), ['printf "codesign %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"']);
      executable(join(fake, 'ditto'), [
        'last=""; for argument in "$@"; do last="$argument"; done',
        ': > "$last"',
        'printf "ditto %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
      ]);
      executable(join(fake, 'xcrun'), ['printf "xcrun %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const output = join(root, 'output');
      const result = invoke(build, ['--output', output], {
        ...process.env,
        PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_TEST_LOG: log,
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip'))).toBe(true);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip.sha256'))).toBe(true);
      const commands = readFileSync(log, 'utf8');
      expect(commands).toContain('swift arm64');
      expect(commands).toContain('swift x86_64');
      expect(commands).toContain('lipo');
      expect(commands).toContain('codesign --force --options runtime --timestamp');
      expect(commands).toContain('codesign --verify --strict');
      expect(commands).toContain('xcrun notarytool submit');
      expect(commands).toContain('--wait');
      expect(commands).toContain('xcrun stapler staple');
      expect(commands).toContain('xcrun stapler validate');
      expect(commands).not.toMatch(/upload|publish|aws|s3|rsync|scp/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
