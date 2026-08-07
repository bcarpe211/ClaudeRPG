import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
const releaseSHA = 'd'.repeat(40);
const releaseContract = readFileSync(join(process.cwd(), 'companion/RELEASE'), 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => line.split('=', 2))
  .reduce<Record<string, string>>((values, [key, value]) => ({ ...values, [key]: value }), {});
const companionVersion = releaseContract.companion_version;
const releaseSequence = releaseContract.release_sequence;
const updateProtocolVersion = '1';

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o755);
}

function fakeReleaseSwift(fake: string, log = false): void {
  executable(join(fake, 'swift'), [
    'arch=""; scratch=""; product=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --arch) arch="$2"; shift 2;; --scratch-path) scratch="$2"; shift 2;; --product) product="$2"; shift 2;; *) shift;; esac; done',
    '[ -n "$scratch" ] || scratch="$PWD/.build"',
    'output="$scratch/$arch-apple-macosx/release"; mkdir -p "$output"',
    'if [ "$product" = runtime-raiders-release-validator ]; then',
    '  if [ -n "${RUNTIME_RAIDERS_TEST_RELEASE_VALIDATOR:-}" ]; then',
    '    cp "$RUNTIME_RAIDERS_TEST_RELEASE_VALIDATOR" "$output/runtime-raiders-release-validator"',
    '  else',
    '    printf "#!/bin/sh\\nexit 0\\n" > "$output/runtime-raiders-release-validator"',
    '    chmod 755 "$output/runtime-raiders-release-validator"',
    '  fi',
    'else',
    '  printf "%s" "$arch" > "$output/raiders"',
    'fi',
    ...(log ? ['printf "swift %s %s\\n" "$arch" "$product" >> "$RUNTIME_RAIDERS_TEST_LOG"'] : []),
  ]);
}

function productionReleaseValidator(root: string): string {
  const scratch = join(root, 'production-release-validator');
  const tmp = join(root, 'production-release-validator-tmp');
  const clang = join(root, 'production-release-validator-clang');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(clang, { recursive: true });
  const result = spawnSync('/usr/bin/swift', [
    'build',
    '--disable-sandbox',
    '--scratch-path', scratch,
    '--product', 'runtime-raiders-release-validator',
  ], {
    cwd: join(process.cwd(), 'companion'),
    env: {
      ...process.env,
      TMPDIR: tmp,
      CLANG_MODULE_CACHE_PATH: clang,
      SWIFTPM_MODULECACHE_OVERRIDE: clang,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`);
  }
  const architecture = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim();
  return join(scratch, `${architecture}-apple-macosx/debug/runtime-raiders-release-validator`);
}

function renderedInstaller(root: string): string {
  const path = join(root, 'install.sh');
  writeFileSync(path, readFileSync(installer, 'utf8')
    .replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', teamId)
    .replaceAll('__RUNTIME_RAIDERS_COMPANION_VERSION__', companionVersion)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SEQUENCE__', releaseSequence)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SHA__', releaseSHA)
    .replaceAll('__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__', updateProtocolVersion));
  chmodSync(path, 0o755);
  return path;
}

type CandidateIdentity = {
  bundleID: string;
  companionVersion: string;
  releaseSequence: string;
  releaseSHA: string;
  updateProtocolVersion: string;
};

function artifact(
  root: string,
  marker = 'initial',
  stateful = true,
  identity: Partial<CandidateIdentity> = {},
): { zip: string; checksum: string } {
  const candidateIdentity: CandidateIdentity = {
    bundleID: 'com.redlattice.runtime-raiders-agent',
    companionVersion,
    releaseSequence,
    releaseSHA,
    updateProtocolVersion,
    ...identity,
  };
  const stage = join(root, 'stage');
  const app = join(stage, 'Runtime Raiders Agent.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  executable(join(app, 'Contents/MacOS/runtime-raiders-agent'), [
    '# ' + marker,
    'printf "' + marker + ':%s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_BINARY_LOG"',
    ...(stateful ? [
      'collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    'running="$HOME/.runtime-raiders-test-running"',
      'job="$HOME/.runtime-raiders-test-job"',
      'polls="$HOME/.runtime-raiders-test-polls"',
      'state_kind=missing; state_enabled=false',
      'if [ -f "$collector_state" ]; then',
      '  if grep -F \'"version":1\' "$collector_state" >/dev/null 2>&1 && grep -F \'"files":\' "$collector_state" >/dev/null 2>&1 && grep -F \'"enabled":false\' "$collector_state" >/dev/null 2>&1; then',
      '    state_kind=disabled',
      '  elif grep -F \'"version":1\' "$collector_state" >/dev/null 2>&1 && grep -F \'"files":\' "$collector_state" >/dev/null 2>&1 && grep -F \'"enabled":true\' "$collector_state" >/dev/null 2>&1; then',
      '    state_kind=enabled; state_enabled=true',
      '  else',
      '    state_kind=invalid',
      '  fi',
      'fi',
      'if [ "${1:-}" = off ]; then',
      '  [ -f "$running" ] || exit 69',
      '  printf \'{"enabled":false,"files":{},"version":1}\\n\' > "$collector_state"',
      '  rm -f "$running"',
      '  printf \'daemon stopped; installed files and queued state preserved\\n\'',
      'fi',
      'if [ "${1:-}" = status ]; then',
      '  daemon_running=false',
      '  if [ -f "$running" ]; then',
      '    count=0; [ ! -f "$polls" ] || count="$(cat "$polls")"',
      '    count=$((count + 1)); printf \'%s\\n\' "$count" > "$polls"',
      '    if [ "$FAKE_DAEMON_NEVER_READY" != 1 ] && [ "$count" -ge "$FAKE_DAEMON_READY_AFTER" ]; then',
      '      daemon_running=true',
      '      if [ "$state_kind" = missing ] || [ "$state_kind" = invalid ]; then',
      '        state_kind=enabled; state_enabled=true',
      '      fi',
      '    fi',
      '  fi',
      '  printf \'{"activeRunCount":0,"compiledAdapters":{},"daemonRunning":%s,"enabled":%s,"lastSuccessfulUploadMS":null,"persistedState":"%s","queuedEventCount":0,"serverEnabledSurfaces":["codex_desktop","codex_cli"]}\\n\' "$daemon_running" "$state_enabled" "$state_kind"',
      'fi',
    ] : []),
  ]);
  writeFileSync(join(app, 'Contents/Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>CFBundleIdentifier</key><string>${candidateIdentity.bundleID}</string>`,
    `<key>CFBundleShortVersionString</key><string>${candidateIdentity.companionVersion}</string>`,
    `<key>RuntimeRaidersReleaseSequence</key><integer>${candidateIdentity.releaseSequence}</integer>`,
    `<key>RuntimeRaidersReleaseSHA</key><string>${candidateIdentity.releaseSHA}</string>`,
    `<key>RuntimeRaidersUpdateProtocolVersion</key><integer>${candidateIdentity.updateProtocolVersion}</integer>`,
    '</dict></plist>',
    '',
  ].join('\n'));
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
    'write_status=0',
    'follow_redirects=0',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in *L*|--location|--location-trusted) follow_redirects=1;; esac',
    '  if [ "$1" = "-o" ]; then output="$2"; shift 2; continue; fi',
    '  if [ "$1" = "-w" ]; then write_status=1; shift 2; continue; fi',
    '  if [ "$1" = "--data" ]; then printf "request %s\\n" "$2" >> "$RUNTIME_RAIDERS_TEST_LOG"; shift 2; continue; fi',
    '  if [ "$1" = "--data-binary" ]; then [ "$2" = "@-" ] || exit 64; cat >/dev/null; shift 2; continue; fi',
    '  last="$1"; shift',
    'done',
    'case "$last" in',
    '  */runtime-raiders-agent.zip)',
    '    if [ "$FAKE_CURL_REDIRECT" = artifact ]; then [ "$follow_redirects" = 0 ] || printf "followed redirect\\n" >> "$RUNTIME_RAIDERS_TEST_LOG"; [ "$follow_redirects" = 1 ] || { [ "$write_status" = 0 ] || printf 307; exit 0; }; fi',
    '    cp "$RUNTIME_RAIDERS_TEST_ZIP" "$output"; [ "$write_status" = 0 ] || printf 200;;',
    '  */runtime-raiders-agent.zip.sha256) cp "$RUNTIME_RAIDERS_TEST_CHECKSUM" "$output"; [ "$write_status" = 0 ] || printf 200;;',
    '  */api/raiders/enroll)',
    '    if [ "$FAKE_CURL_REDIRECT" = enrollment ]; then [ "$follow_redirects" = 0 ] || printf "followed redirect\\n" >> "$RUNTIME_RAIDERS_TEST_LOG"; [ "$follow_redirects" = 1 ] || { [ "$write_status" = 0 ] || printf 307; exit 0; }; fi',
    '    printf "%s" "$RUNTIME_RAIDERS_TEST_ENROLLMENT" > "$output"; [ "$write_status" = 0 ] || printf 201;;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'stat'), [
    'if [ "${1:-}" = -f ] && [ "${2:-}" = %u ] && [ "${3:-}" = "$RUNTIME_RAIDERS_TEST_CODE_FILE" ] && [ -n "$FAKE_CODE_FILE_OWNER" ]; then',
    '  printf "%s\\n" "$FAKE_CODE_FILE_OWNER"',
    '  exit 0',
    'fi',
    'exec /usr/bin/stat "$@"',
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
      'running="$HOME/.runtime-raiders-test-running"',
    'job="$HOME/.runtime-raiders-test-job"',
    'polls="$HOME/.runtime-raiders-test-polls"',
    'if [ "$1" = print ]; then',
    '  [ "$FAKE_LAUNCH_PRINT_PRESENT" = 1 ] && exit 0',
    '  [ "$FAKE_LAUNCH_PRINT_ABSENT" = 1 ] && { printf "Could not find service\\n" >&2; exit 113; }',
    '  [ "$FAKE_LAUNCH_PRINT_AMBIGUOUS" != 1 ] || { printf "launchctl print ambiguous failure\\n" >&2; exit 77; }',
    '  [ -f "$job" ] && exit 0',
    '  printf "Could not find service\\n" >&2; exit 113',
    'fi',
    'if [ "$1" = bootout ] && [ "$FAKE_LAUNCH_BOOTOUT_FAIL" = 1 ]; then printf "bootout ambiguous failure\\n" >&2; exit 77; fi',
    'if [ "$1" = bootstrap ] && [ "$FAKE_LAUNCH_BOOTSTRAP_FAIL" = 1 ]; then printf "bootstrap failure\\n" >&2; exit 77; fi',
    'if [ "$1" = bootstrap ] && [ "$FAKE_LAUNCH_REQUIRE_OFF" = 1 ]; then',
    '  collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    '  grep -F \'"enabled":false\' "$collector_state" >/dev/null 2>&1 || { printf "bootstrap observed collection enabled\\n" >&2; exit 78; }',
    'fi',
    'if [ "$1" = bootout ]; then rm -f "$job" "$running" "$polls"; fi',
    'if [ "$1" = bootstrap ]; then',
    '  collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    '  if ! grep -F \'"enabled":false\' "$collector_state" >/dev/null 2>&1; then',
    '    printf "endpoint /api/runs/events\\nendpoint /api/raiders/heartbeat\\n" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    '  fi',
    '  : > "$job"; : > "$running"; rm -f "$polls"',
    'fi',
    'printf "launchctl %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
  ]);
  executable(join(bin, 'uuidgen'), ['printf "%s\\n" "00000000-0000-4000-8000-000000000001"']);
  executable(join(bin, 'sleep'), ['printf "sleep %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"']);
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
    FAKE_LAUNCH_PRINT_ABSENT: '0',
    FAKE_LAUNCH_PRINT_AMBIGUOUS: '0',
    FAKE_LAUNCH_BOOTOUT_FAIL: '0',
    FAKE_LAUNCH_BOOTSTRAP_FAIL: '0',
    FAKE_LAUNCH_REQUIRE_OFF: '0',
    FAKE_DAEMON_READY_AFTER: '1',
    FAKE_DAEMON_NEVER_READY: '0',
    FAKE_CURL_REDIRECT: '',
    FAKE_CODE_FILE_OWNER: '',
    RUNTIME_RAIDERS_TEST_CODE_FILE: '',
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

function oneTimeCodeFile(root: string, code = enrollmentCode, fileMode = 0o600): string {
  const path = join(root, 'one-time-code');
  writeFileSync(path, `${code}\n`);
  chmodSync(path, fileMode);
  return path;
}

function installerArgs(root: string, code = enrollmentCode, fileMode = 0o600): string[] {
  return ['--code-file', oneTimeCodeFile(root, code, fileMode)];
}

function buildCacheIdentity(path: string): string[] {
  if (!existsSync(path)) return ['missing'];
  const entries: string[] = [];
  const visit = (current: string, relative: string): void => {
    const entry = lstatSync(current);
    entries.push([relative, entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeMs, entry.ctimeMs].join(':'));
    if (!entry.isDirectory()) return;
    for (const child of readdirSync(current).sort()) visit(join(current, child), join(relative, child));
  };
  visit(path, '.');
  return entries;
}

type ReleaseBuilderFixture = { build: string; repository: string; releaseSHA: string };

type ReleaseBuilderFixtureOptions = {
  interceptAbsoluteDitto?: boolean;
};

function disposableReleaseBuilder(
  root: string,
  options: ReleaseBuilderFixtureOptions = {},
): ReleaseBuilderFixture {
  const repository = join(root, 'repository');
  const fixtureBuild = join(repository, 'scripts/release/build-runtime-raiders-agent.sh');
  const fixtureInstaller = join(repository, 'companion/packaging/install.sh');
  mkdirSync(join(repository, 'scripts/release'), { recursive: true });
  mkdirSync(join(repository, 'companion/packaging'), { recursive: true });
  let fixtureBuildContents = readFileSync(build, 'utf8');
  if (options.interceptAbsoluteDitto) {
    fixtureBuildContents = fixtureBuildContents.replaceAll(
      '/usr/bin/ditto',
      '"$RUNTIME_RAIDERS_TEST_DITTO"',
    );
  }
  writeFileSync(fixtureBuild, fixtureBuildContents);
  writeFileSync(fixtureInstaller, readFileSync(installer));
  writeFileSync(join(repository, 'companion/RELEASE'), readFileSync(join(process.cwd(), 'companion/RELEASE')));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Release Test'], { cwd: repository });
  execFileSync('/usr/bin/git', ['add', 'scripts/release/build-runtime-raiders-agent.sh', 'companion/packaging/install.sh', 'companion/RELEASE'], { cwd: repository });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'release fixture'], { cwd: repository });
  const fixtureSHA = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  return { build: fixtureBuild, repository, releaseSHA: fixtureSHA };
}

function releaseBuildArgs(sha: string, ...args: string[]): string[] {
  return ['--release-sha', sha, ...args];
}

describe('Runtime Raiders companion installer', () => {
  it('rejects every mismatched sealed candidate identity before enrollment or replacement', () => {
    // Catches an installer that verifies only the signature while accepting the wrong signed release.
    const mutations: Array<[string, Partial<CandidateIdentity>]> = [
      ['bundle ID', { bundleID: 'com.redlattice.other-agent' }],
      ['companion version', { companionVersion: companionVersion === '9.9.9' ? '9.9.8' : '9.9.9' }],
      ['release sequence', { releaseSequence: String(Number(releaseSequence) + 1) }],
      ['release SHA', { releaseSHA: 'e'.repeat(40) }],
      ['update protocol', { updateProtocolVersion: '2' }],
    ];
    for (const [name, mutation] of mutations) {
      const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-identity-'));
      try {
        const home = join(root, 'home');
        const commandDir = join(home, 'bin');
        mkdirSync(commandDir, { recursive: true });
        const environment = env(home, fakes(root), artifact(root, name, true, mutation), commandDir);

        const result = invoke(renderedInstaller(root), installerArgs(root), environment);

        expect(result.status, `${name}: ${result.stderr}`).not.toBe(0);
        expect(result.stderr, name).toContain('candidate release identity is invalid');
        const commands = readFileSync(join(home, 'commands.log'), 'utf8');
        expect(commands, name).not.toContain('/api/raiders/enroll');
        expect(existsSync(join(
          home,
          'Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app',
        )), name).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('persists collection off before the first launchd bootstrap and performs no upload', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-fresh-off-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment: NodeJS.ProcessEnv = {
        ...env(home, fakes(root), artifact(root, 'fresh-off', true), commandDir),
        FAKE_LAUNCH_REQUIRE_OFF: '1',
      };

      const result = invoke(renderedInstaller(root), installerArgs(root), environment);

      expect(result.status, result.stderr).toBe(0);
      const state = JSON.parse(readFileSync(join(
        home,
        'Library/Application Support/Runtime Raiders/state/collector-state.json',
      ), 'utf8')) as { version: number; enabled: boolean; files: object };
      expect(state).toEqual({ version: 1, enabled: false, files: {} });
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('/api/runs/events');
      expect(commands).not.toContain('/api/raiders/heartbeat');
      expect(readFileSync(join(home, 'binary.log'), 'utf8')).toContain('fresh-off:status\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('turns an enabled existing collector off and verifies it before replacement bootstrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-upgrade-off-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root, 'installed', true), commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const state = join(
        home,
        'Library/Application Support/Runtime Raiders/state/collector-state.json',
      );
      writeFileSync(state, '{"enabled":true,"files":{},"version":1}\n');
      writeFileSync(join(home, 'binary.log'), '');
      const upgradeFiles = artifact(root, 'replacement', true);

      const result = invoke(renderedInstaller(root), installerArgs(root), {
        ...base,
        ...env(home, join(root, 'fakes'), upgradeFiles, commandDir),
        FAKE_LAUNCH_REQUIRE_OFF: '1',
      });

      expect(result.status, result.stderr).toBe(0);
      const binaryLog = readFileSync(join(home, 'binary.log'), 'utf8');
      expect(binaryLog).toContain('installed:off\n');
      expect(binaryLog.indexOf('installed:off\n')).toBeLessThan(binaryLog.indexOf('replacement:status\n'));
      expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ enabled: false });
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
      expect(readFileSync(
        join(home, 'Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'),
        'utf8',
      )).toContain('# replacement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a live already-disabled collector byte-for-byte without invoking off', () => {
    // Catches quiescence that destructively turns off an already-disabled installation.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-disabled-upgrade-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root, 'installed', true), commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const state = join(
        home,
        'Library/Application Support/Runtime Raiders/state/collector-state.json',
      );
      const preserved = '{"enabled":false,"files":{"synthetic.jsonl":{"adapterSnapshots":{"codex_cli":"Y2xp","codex_desktop":"ZGVza3RvcA=="},"cursor":{"offset":17,"partialLine":""},"nextOrdinal":4,"seeding":true}},"version":1}\n';
      writeFileSync(state, preserved);
      writeFileSync(join(home, 'commands.log'), '');
      writeFileSync(join(home, 'binary.log'), '');
      const replacement = artifact(root, 'replacement', true);

      const result = invoke(renderedInstaller(root), installerArgs(root), {
        ...base,
        ...env(home, join(root, 'fakes'), replacement, commandDir),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(state, 'utf8')).toBe(preserved);
      const binaryLog = readFileSync(join(home, 'binary.log'), 'utf8');
      expect(binaryLog).toContain('installed:status\n');
      expect(binaryLog).not.toContain('installed:off\n');
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('/api/raiders/enroll');
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers an unavailable app-present install with missing state before replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-missing-state-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root, 'installed'), commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const state = join(home, 'Library/Application Support/Runtime Raiders/state/collector-state.json');
      rmSync(state);
      rmSync(join(home, '.runtime-raiders-test-running'), { force: true });
      writeFileSync(join(home, 'commands.log'), '');
      writeFileSync(join(home, 'binary.log'), '');

      const result = invoke(renderedInstaller(root), installerArgs(root), {
        ...base,
        ...env(home, join(root, 'fakes'), artifact(root, 'replacement'), commandDir),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ enabled: false, files: {}, version: 1 });
      expect(readFileSync(join(home, 'binary.log'), 'utf8')).toContain('replacement:status');
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers corrupt offline persisted state only after the old job is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-invalid-state-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const base = env(home, fakes(root), artifact(root, 'installed'), commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const state = join(home, 'Library/Application Support/Runtime Raiders/state/collector-state.json');
      writeFileSync(state, 'corrupt-state\n');
      rmSync(join(home, '.runtime-raiders-test-running'), { force: true });
      writeFileSync(join(home, 'commands.log'), '');

      const result = invoke(renderedInstaller(root), installerArgs(root), {
        ...base,
        ...env(home, join(root, 'fakes'), artifact(root, 'replacement'), commandDir),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ enabled: false, files: {}, version: 1 });
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands.indexOf('launchctl bootout')).toBeLessThan(commands.indexOf('launchctl bootstrap'));
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits through delayed launchd readiness until the live daemon reports off', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-delayed-daemon-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = {
        ...env(home, fakes(root), artifact(root, 'delayed'), commandDir),
        FAKE_DAEMON_READY_AFTER: '3',
      };

      const result = invoke(renderedInstaller(root), installerArgs(root), environment);

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(home, 'binary.log'), 'utf8').match(/delayed:status/g)?.length).toBeGreaterThanOrEqual(3);
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands.match(/sleep 0\.25/g)).toHaveLength(2);
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back when launchd never produces a live verified-off daemon', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-never-ready-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const environment = {
        ...env(home, fakes(root), artifact(root, 'never-ready'), commandDir),
        FAKE_DAEMON_NEVER_READY: '1',
      };

      const result = invoke(renderedInstaller(root), installerArgs(root), environment);

      expect(result.status).not.toBe(0);
      expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app'))).toBe(false);
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the prior off app after readiness failure and permits a safe retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-readiness-retry-'));
    try {
      const home = join(root, 'home');
      const commandDir = join(home, 'bin');
      mkdirSync(commandDir, { recursive: true });
      const initialFiles = artifact(root, 'initial');
      const base = env(home, fakes(root), initialFiles, commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const installed = join(
        home,
        'Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent',
      );

      const failedFiles = artifact(root, 'failed-replacement');
      const failed = invoke(renderedInstaller(root), installerArgs(root), {
        ...base,
        ...env(home, join(root, 'fakes'), failedFiles, commandDir),
        FAKE_DAEMON_NEVER_READY: '1',
      });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(installed, 'utf8')).toContain('# initial');

      const retryFiles = artifact(root, 'retry-replacement');
      const retry = invoke(renderedInstaller(root), installerArgs(root), {
        ...base,
        ...env(home, join(root, 'fakes'), retryFiles, commandDir),
      });
      expect(retry.status, retry.stderr).toBe(0);
      expect(readFileSync(installed, 'utf8')).toContain('# retry-replacement');
      const commands = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('endpoint /api/runs/events');
      expect(commands).not.toContain('endpoint /api/raiders/heartbeat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      const first = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      const second = invoke(renderedInstaller(root), installerArgs(root), environment);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(join(state, 'cursor.json'), 'utf8')).toBe('cursor');
      expect(readFileSync(join(support, 'outbox', 'event.json'), 'utf8')).toBe('event');
      const log = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(log.match(/api\/raiders\/enroll/g)).toHaveLength(1);
      expect(log).toContain('--data-binary @-');
      expect(log).not.toContain(enrollmentCode);
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
        const result = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      const codeFile = oneTimeCodeFile(root);
      const result = spawnSync('/bin/sh', ['-s', '--', '--code-file', codeFile], {
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
      const install = invoke(renderedInstaller(root), installerArgs(root), environment);
      expect(install.status, install.stderr).toBe(0);
      const marker = 'export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path';
      expect(readFileSync(profile, 'utf8')).toBe('# before\nexport OTHER=1\n# after\n' + marker + '\n');
      const command = join(home, '.local/bin/raiders');
      expect(lstatSync(command).isSymbolicLink()).toBe(true);
      const reinstall = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      expect(invoke(renderedInstaller(root), installerArgs(root), environment).status).toBe(0);
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
      const base = env(home, fakes(root), artifact(root), commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const environment = { ...base, FAKE_LAUNCH_PRINT_PRESENT: '1' };
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
      expect(invoke(renderedInstaller(root), installerArgs(root), environment).status).toBe(0);
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
      const environment = env(home, fakes(root), artifact(root), commandDir);
      expect(invoke(renderedInstaller(root), installerArgs(root), environment).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      executable(join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'), ['exit 23']);
      const uninstall = spawnSync(join(support, 'raiders'), ['uninstall'], {
        env: { ...environment, FAKE_LAUNCH_PRINT_AMBIGUOUS: '1' }, encoding: 'utf8',
      });
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
      expect(invoke(renderedInstaller(root), installerArgs(root), environment).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      executable(join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'), ['exit 23']);
      const uninstall = spawnSync(join(support, 'raiders'), ['uninstall'], {
        env: { ...environment, FAKE_LAUNCH_PRINT_ABSENT: '1' }, encoding: 'utf8',
      });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(existsSync(support)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the enrollment code and complete request JSON out of curl argv and logs', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-secret-argv-'));
    try {
      const home = join(root, 'home');
      const codeFile = oneTimeCodeFile(root);
      const environment: NodeJS.ProcessEnv = {
        ...env(home, fakes(root), artifact(root)),
        RUNTIME_RAIDERS_TEST_CODE_FILE: codeFile,
      };

      const result = invoke(
        renderedInstaller(root),
        ['--code-file', codeFile],
        environment,
      );

      expect(result.status, result.stderr).toBe(0);
      const commands = readFileSync(environment.RUNTIME_RAIDERS_TEST_LOG!, 'utf8');
      expect(commands).toContain('--data-binary @-');
      expect(commands).not.toContain(enrollmentCode);
      expect(commands).not.toContain('{"code"');
      expect(commands).not.toContain('"device_id"');
      expect(commands).toContain('--proto =https');
      expect(commands).toContain('--max-redirs 0');
      expect(commands).toContain('--connect-timeout 10');
      expect(commands).toContain('--max-time');
      expect(commands).toContain('--max-filesize');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['artifact', 'enrollment'] as const)(
    'refuses a %s redirect without forwarding enrollment secrets',
    (redirect) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-${redirect}-redirect-`));
      try {
        const home = join(root, 'home');
        mkdirSync(home, { recursive: true });
        const codeFile = oneTimeCodeFile(root);
        const environment: NodeJS.ProcessEnv = {
          ...env(home, fakes(root), artifact(root)),
          FAKE_CURL_REDIRECT: redirect,
          RUNTIME_RAIDERS_TEST_CODE_FILE: codeFile,
        };
        writeFileSync(environment.RUNTIME_RAIDERS_TEST_LOG!, '');

        const result = invoke(
          renderedInstaller(root),
          ['--code-file', codeFile],
          environment,
        );

        expect(result.status).not.toBe(0);
        const commands = readFileSync(environment.RUNTIME_RAIDERS_TEST_LOG!, 'utf8');
        expect(commands).toContain('curl ');
        expect(commands).not.toContain('followed redirect');
        expect(commands).not.toContain(enrollmentCode);
        expect(commands).not.toContain('{"code"');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['group-readable mode', (root: string) => oneTimeCodeFile(root, enrollmentCode, 0o640), {}],
    ['directory', (root: string) => {
      const path = join(root, 'one-time-code');
      mkdirSync(path);
      return path;
    }, {}],
    ['symlink', (root: string) => {
      const target = join(root, 'actual-code');
      writeFileSync(target, `${enrollmentCode}\n`);
      chmodSync(target, 0o600);
      const path = join(root, 'one-time-code');
      symlinkSync(target, path);
      return path;
    }, {}],
    ['different owner', (root: string) => oneTimeCodeFile(root), { FAKE_CODE_FILE_OWNER: '65534' }],
  ] as const)('rejects an unsafe one-time code file: %s', (_name, makeCodeFile, overrides) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-unsafe-code-file-'));
    try {
      const home = join(root, 'home');
      const codeFile = makeCodeFile(root);
      const environment: NodeJS.ProcessEnv = {
        ...env(home, fakes(root), artifact(root)),
        ...overrides,
        RUNTIME_RAIDERS_TEST_CODE_FILE: codeFile,
      };

      const result = invoke(
        renderedInstaller(root),
        ['--code-file', codeFile],
        environment,
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(environment.RUNTIME_RAIDERS_TEST_LOG!)).toBe(false);
      expect(result.stderr).not.toContain(enrollmentCode);
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
      const result = invoke(renderedInstaller(root), installerArgs(root, 'bad"code'), environment);
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
      const result = invoke(installer, installerArgs(root), environment);
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
      const result = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      const result = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const appBinary = join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent');
      const plist = join(home, 'Library/LaunchAgents', label + '.plist');
      const shim = join(support, 'raiders');
      const config = join(support, 'state/enrollment.json');
      const command = join(commandDir, 'raiders');
      const before = [readFileSync(appBinary, 'utf8'), readFileSync(plist, 'utf8'), readFileSync(shim, 'utf8'), readFileSync(config, 'utf8'), readFileSync(join(support, 'state/command-link'), 'utf8'), readFileSync(command)];
      const result = invoke(renderedInstaller(root), installerArgs(root), {
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
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const plist = join(home, 'Library/LaunchAgents', label + '.plist');
      const command = join(commandDir, 'raiders');
      const files = [
        join(support, 'Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent'),
        plist, join(support, 'raiders'), join(support, 'state/enrollment.json'), join(support, 'state/command-link'),
      ];
      const before = files.map((file) => readFileSync(file, 'utf8'));
      const result = invoke(renderedInstaller(root), installerArgs(root), {
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
      const first = invoke(renderedInstaller(root), installerArgs(root), { ...base, FAKE_LAUNCH_BOOTSTRAP_FAIL: '1' });
      expect(first.status).not.toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      expect(existsSync(join(support, 'state/enrollment.json'))).toBe(true);
      expect(existsSync(join(support, 'Runtime Raiders Agent.app'))).toBe(false);
      expect(existsSync(join(home, 'Library/LaunchAgents', label + '.plist'))).toBe(false);
      expect(existsSync(join(support, 'raiders'))).toBe(false);
      expect(existsSync(join(commandDir, 'raiders'))).toBe(false);
      expect(existsSync(join(support, 'state/command-link'))).toBe(false);
      const retry = invoke(renderedInstaller(root), installerArgs(root), base);
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
      expect(invoke(renderedInstaller(root), installerArgs(root), base).status).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const oldCommand = join(oldDir, 'raiders');
      unlinkSync(oldCommand);
      writeFileSync(oldCommand, 'user replacement');
      const newEnvironment = env(home, join(root, 'fakes'), artifact(root, 'replacement'), newDir);
      const failed = invoke(renderedInstaller(root), installerArgs(root), { ...newEnvironment, FAKE_LAUNCH_BOOTSTRAP_FAIL: '1' });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(oldCommand, 'utf8')).toBe('user replacement');
      expect(readFileSync(join(support, 'state/command-link'), 'utf8')).toBe(oldCommand + '\n');
      const upgraded = invoke(renderedInstaller(root), installerArgs(root), newEnvironment);
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
      const result = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      const result = spawnSync('bash', [renderedInstaller(root), ...installerArgs(root)], {
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
      const result = invoke(renderedInstaller(root), installerArgs(root), environment);
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
      expect(invoke(renderedInstaller(root), installerArgs(root), environment).status).toBe(0);
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
  it('seals the exact reviewed release identity into the app before signing', () => {
    // Catches a signed bundle whose runtime identity cannot pass CompanionReleaseIdentity parsing.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-sealed-release-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const capturedPlist = join(root, 'Info.plist');
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), [
        'output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done',
        'printf universal > "$output"',
      ]);
      executable(join(fake, 'codesign'), [
        'signing=0; last=""',
        'for argument in "$@"; do [ "$argument" = --force ] && signing=1; last="$argument"; done',
        '[ "$signing" = 0 ] || { /usr/bin/plutil -lint "$last/Contents/Info.plist" >/dev/null && /bin/cp "$last/Contents/Info.plist" "$RUNTIME_RAIDERS_TEST_PLIST"; }',
      ]);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);

      const fixture = disposableReleaseBuilder(root);
      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', join(root, 'output'), '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_TEST_PLIST: capturedPlist,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const value = (key: string) => execFileSync(
        '/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', capturedPlist], { encoding: 'utf8' },
      ).trim();
      expect(value('CFBundleIdentifier')).toBe('com.redlattice.runtime-raiders-agent');
      expect(value('CFBundleShortVersionString')).toBe(companionVersion);
      expect(value('RuntimeRaidersReleaseSequence')).toBe(releaseSequence);
      expect(value('RuntimeRaidersReleaseSHA')).toBe(fixture.releaseSHA);
      expect(value('RuntimeRaidersUpdateProtocolVersion')).toBe('1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects absent or malformed release identity before invoking the build', () => {
    // Catches ambiguous, unsafe, or synthesized metadata reaching Swift build or signing.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-contract-'));
    try {
      const fake = join(root, 'fakes');
      const invoked = join(root, 'build-invoked');
      mkdirSync(fake, { recursive: true });
      executable(join(fake, 'swift'), ['printf invoked > "$RUNTIME_RAIDERS_TEST_BUILD_INVOKED"', 'exit 91']);
      const environment = {
        ...process.env,
        PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_TEST_BUILD_INVOKED: invoked,
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
      };
      const fixture = disposableReleaseBuilder(root);
      const releaseFile = join(fixture.repository, 'companion/RELEASE');

      const missingSHA = invoke(fixture.build, ['--output', join(root, 'missing-sha')], environment);
      expect(missingSHA.status).toBe(64);
      expect(missingSHA.stderr).toContain('--release-sha is required');
      expect(existsSync(invoked)).toBe(false);

      for (const [name, contents, message] of [
        ['missing file', null, 'companion/RELEASE is required'],
        ['missing newline', 'version=1\ncompanion_version=0.2.0\nrelease_sequence=1\nupdate_protocol_version=1', 'companion/RELEASE is invalid'],
        ['extra line', 'version=1\ncompanion_version=0.2.0\nrelease_sequence=1\nupdate_protocol_version=1\nextra=1\n', 'companion/RELEASE is invalid'],
        ['unsafe version', 'version=1\ncompanion_version=0.2.0</string>\nrelease_sequence=1\nupdate_protocol_version=1\n', 'companion_version is invalid'],
        ['zero sequence', 'version=1\ncompanion_version=0.2.0\nrelease_sequence=0\nupdate_protocol_version=1\n', 'release_sequence is invalid'],
        ['unsafe sequence', 'version=1\ncompanion_version=0.2.0\nrelease_sequence=9007199254740992\nupdate_protocol_version=1\n', 'release_sequence is invalid'],
        ['unsupported protocol', 'version=1\ncompanion_version=0.2.0\nrelease_sequence=1\nupdate_protocol_version=2\n', 'update_protocol_version is invalid'],
      ] as const) {
        if (contents === null) rmSync(releaseFile, { force: true });
        else writeFileSync(releaseFile, contents);
        const result = invoke(
          fixture.build,
          releaseBuildArgs(fixture.releaseSHA, '--output', join(root, name.replaceAll(' ', '-'))),
          environment,
        );
        expect(result.status, `${name}: ${result.stderr}`).toBe(64);
        expect(result.stderr, name).toContain(message);
        expect(existsSync(invoked), name).toBe(false);
      }

      writeFileSync(releaseFile, readFileSync(join(process.cwd(), 'companion/RELEASE')));
      for (const malformedSHA of ['D'.repeat(40), 'd'.repeat(39), 'd'.repeat(41), 'g'.repeat(40)]) {
        const result = invoke(
          fixture.build,
          ['--release-sha', malformedSHA, '--output', join(root, 'bad-sha')],
          environment,
        );
        expect(result.status, result.stderr).toBe(64);
        expect(result.stderr).toContain('--release-sha is invalid');
        expect(existsSync(invoked)).toBe(false);
      }
      const duplicateSHA = invoke(
        fixture.build,
        ['--release-sha', fixture.releaseSHA, '--release-sha', fixture.releaseSHA, '--output', join(root, 'duplicate-sha')],
        environment,
      );
      expect(duplicateSHA.status).toBe(64);
      expect(duplicateSHA.stderr).toContain('--release-sha may be provided only once');
      expect(existsSync(invoked)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires the requested release SHA to equal a clean Git HEAD before invoking the build', () => {
    // Catches releasing bytes from a different commit or from tracked/untracked local changes.
    for (const state of ['mismatched HEAD', 'dirty tracked', 'dirty untracked'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-git-'));
      try {
        const fake = join(root, 'fakes');
        const invoked = join(root, 'build-invoked');
        mkdirSync(fake, { recursive: true });
        executable(join(fake, 'swift'), ['printf invoked > "$RUNTIME_RAIDERS_TEST_BUILD_INVOKED"', 'exit 91']);
        const fixture = disposableReleaseBuilder(root);
        let requestedSHA = fixture.releaseSHA;
        if (state === 'mismatched HEAD') requestedSHA = 'e'.repeat(40);
        if (state === 'dirty tracked') writeFileSync(join(fixture.repository, 'companion/RELEASE'), [
          'version=1',
          'companion_version=0.2.1',
          'release_sequence=2',
          'update_protocol_version=1',
          '',
        ].join('\n'));
        if (state === 'dirty untracked') writeFileSync(join(fixture.repository, 'untracked-release-note'), 'dirty\n');

        const result = invoke(
          fixture.build,
          releaseBuildArgs(requestedSHA, '--output', join(root, 'output'), '--scratch-path', join(root, 'scratch')),
          {
            ...process.env,
            PATH: fake + ':/usr/bin:/bin',
            RUNTIME_RAIDERS_TEST_BUILD_INVOKED: invoked,
            RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
            RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
            RUNTIME_RAIDERS_TEAM_ID: teamId,
          },
        );

        expect(result.status, `${state}: ${result.stderr}`).toBe(64);
        expect(result.stderr, state).toContain(
          state === 'mismatched HEAD' ? 'release SHA does not match Git HEAD' : 'Git worktree is not clean',
        );
        expect(existsSync(invoked), state).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

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

  it('resolves a relative scratch path against the caller before building', () => {
    // Catches resolving one scratch argument from two different working directories.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-relative-scratch-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const output = join(root, 'output');
      const fixture = disposableReleaseBuilder(root);
      const result = spawnSync('bash', [
        fixture.build, ...releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', 'relative-scratch'),
      ], {
        cwd: root,
        env: {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, 'relative-scratch/arm64-apple-macosx/release/raiders'), 'utf8')).toBe('arm64');
      expect(readFileSync(join(root, 'relative-scratch/x86_64-apple-macosx/release/raiders'), 'utf8')).toBe('x86_64');
      expect(existsSync(join(root, 'companion/relative-scratch'))).toBe(false);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates, extracts, and revalidates the notarized ditto archive before emitting a quartet', () => {
    // Catches final packaging that drops macOS signature metadata or trusts only the pre-archive app.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-flow-'));
    try {
      const builderContents = readFileSync(build, 'utf8');
      expect(builderContents).toContain(
        '/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$STAGED_OUTPUT/runtime-raiders-agent.zip"',
      );
      expect(builderContents).toContain(
        '/usr/bin/ditto -x -k "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$ARCHIVE_VALIDATION"',
      );
      expect(builderContents).not.toContain('/usr/bin/zip');

      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const log = join(root, 'commands.log');
      fakeReleaseSwift(fake, true);
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
        'printf "ditto %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'exec /usr/bin/ditto "$@"',
      ]);
      executable(join(fake, 'xcrun'), ['printf "xcrun %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"']);
      executable(join(fake, 'shasum'), [
        'printf "shasum %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'if [ "$FAKE_RELEASE_SHASUM_FAIL" = 1 ]; then exit 1; fi',
        'exec /usr/bin/shasum "$@"',
      ]);
      const output = join(root, 'output');
      const scratch = join(root, 'scratch');
      const releaseValidator = productionReleaseValidator(root);
      const loggingReleaseValidator = join(root, 'logging-release-validator');
      executable(loggingReleaseValidator, [
        'printf "release-validator %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'exec "$RUNTIME_RAIDERS_TEST_PRODUCTION_RELEASE_VALIDATOR" "$@"',
      ]);
      const fixture = disposableReleaseBuilder(root, { interceptAbsoluteDitto: true });
      const repositoryCacheBefore = buildCacheIdentity(join(process.cwd(), 'companion/.build'));
      const result = invoke(fixture.build, releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', scratch), {
        ...process.env,
        PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_TEST_LOG: log,
        RUNTIME_RAIDERS_TEST_DITTO: join(fake, 'ditto'),
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
        RUNTIME_RAIDERS_TEST_RELEASE_VALIDATOR: loggingReleaseValidator,
        RUNTIME_RAIDERS_TEST_PRODUCTION_RELEASE_VALIDATOR: releaseValidator,
        FAKE_RELEASE_SHASUM_FAIL: '0',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(buildCacheIdentity(join(process.cwd(), 'companion/.build'))).toEqual(repositoryCacheBefore);
      expect(readFileSync(join(scratch, 'arm64-apple-macosx/release/raiders'), 'utf8')).toBe('arm64');
      expect(readFileSync(join(scratch, 'x86_64-apple-macosx/release/raiders'), 'utf8')).toBe('x86_64');
      expect(existsSync(join(output, 'runtime-raiders-agent.zip'))).toBe(true);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip.sha256'))).toBe(true);
      expect(readdirSync(output).sort()).toEqual([
        'install.sh',
        'runtime-raiders-agent.update.json',
        'runtime-raiders-agent.zip',
        'runtime-raiders-agent.zip.sha256',
      ]);
      const zipPath = join(output, 'runtime-raiders-agent.zip');
      const productionValidation = spawnSync(releaseValidator, [zipPath], { encoding: 'utf8' });
      const zipFacts = execFileSync('/usr/bin/zipinfo', ['-v', zipPath], { encoding: 'utf8' });
      expect(
        productionValidation.status,
        `${productionValidation.stdout}${productionValidation.stderr}\n${zipFacts}`,
      ).toBe(0);
      const zipDigest = execFileSync('/usr/bin/shasum', ['-a', '256', zipPath], { encoding: 'utf8' }).split(/\s+/)[0];
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'utf8')).toBe(
        `${zipDigest}  runtime-raiders-agent.zip\n`,
      );
      expect(readFileSync(join(output, 'runtime-raiders-agent.update.json'), 'utf8')).toBe(JSON.stringify({
        companion_version: companionVersion,
        manifest_version: 1,
        release_sequence: Number(releaseSequence),
        release_sha: fixture.releaseSHA,
        update_protocol_version: 1,
        zip_sha256: zipDigest,
        zip_url: 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
      }) + '\n');
      const rendered = readFileSync(join(output, 'install.sh'), 'utf8');
      expect(rendered).toContain("TEAM_ID='" + teamId + "'");
      expect(rendered).toContain("VERSION='" + companionVersion + "'");
      expect(rendered).toContain("RELEASE_SEQUENCE='" + releaseSequence + "'");
      expect(rendered).toContain("RELEASE_SHA='" + fixture.releaseSHA + "'");
      expect(rendered).toContain("UPDATE_PROTOCOL_VERSION='" + updateProtocolVersion + "'");
      expect(rendered).toContain("ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'");
      expect(rendered).toContain("CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'");
      expect(rendered).not.toContain('__RUNTIME_RAIDERS_');
      const zipEntries = execFileSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8' })
        .trim().split('\n');
      expect(new Set(zipEntries.map((entry) => entry.split('/')[0]))).toEqual(new Set(['Runtime Raiders Agent.app']));
      expect(zipEntries.some((entry) => entry.startsWith('__MACOSX/'))).toBe(false);
      const commands = readFileSync(log, 'utf8');
      expect(commands).toContain('swift arm64');
      expect(commands).toContain('swift x86_64');
      expect(commands).toContain('lipo');
      expect(commands).toContain('codesign --force --options runtime --timestamp');
      expect(commands).toContain('codesign --verify --strict --verbose=2 --all-architectures');
      expect(commands).toContain('codesign --verify --strict --verbose=2 --all-architectures -R=identifier "com.redlattice.runtime-raiders-agent"');
      expect(commands).toContain('xcrun notarytool submit');
      expect(commands).toContain('--wait');
      expect(commands).toContain('xcrun stapler staple');
      expect(commands).toContain('xcrun stapler validate');
      const commandLines = commands.trim().split('\n');
      const dittoCommands = commandLines.filter((line) => line.startsWith('ditto '));
      expect(dittoCommands).toHaveLength(3);
      expect(dittoCommands.filter((line) => line.includes('-c -k --sequesterRsrc --keepParent'))).toHaveLength(2);
      expect(dittoCommands.filter((line) => line.startsWith('ditto -x -k '))).toHaveLength(1);
      expect(commandLines.filter((line) => line.startsWith('xcrun notarytool submit '))).toHaveLength(1);
      expect(commandLines.filter((line) => line.startsWith('xcrun stapler staple '))).toHaveLength(1);
      expect(commandLines.filter((line) => line.startsWith('codesign --verify '))).toHaveLength(3);
      expect(commandLines.filter((line) => line.startsWith('xcrun stapler validate '))).toHaveLength(2);

      const notaryCreate = commandLines.findIndex((line) =>
        line.startsWith('ditto -c -k --sequesterRsrc --keepParent ') && line.endsWith('/notary.zip'));
      const notarySubmit = commandLines.findIndex((line) => line.startsWith('xcrun notarytool submit '));
      const staple = commandLines.findIndex((line) => line.startsWith('xcrun stapler staple '));
      const finalCreate = commandLines.findIndex((line) =>
        line.startsWith('ditto -c -k --sequesterRsrc --keepParent ') &&
        line.endsWith('/runtime-raiders-agent.zip'));
      const extract = commandLines.findIndex((line) => line.startsWith('ditto -x -k '));
      const extractedCodesign = commandLines.findIndex((line) =>
        line.startsWith('codesign --verify ') && line.includes('/archive-validation.'));
      const extractedStapler = commandLines.findIndex((line) =>
        line.startsWith('xcrun stapler validate ') && line.includes('/archive-validation.'));
      const archiveValidator = commandLines.findIndex((line) => line.startsWith('release-validator '));
      const checksum = commandLines.findIndex((line) => line.startsWith('shasum -a 256 '));
      expect([
        notaryCreate,
        notarySubmit,
        staple,
        finalCreate,
        extract,
        extractedCodesign,
        extractedStapler,
        archiveValidator,
        checksum,
      ].every((index) => index >= 0)).toBe(true);
      expect(notaryCreate).toBeLessThan(notarySubmit);
      expect(notarySubmit).toBeLessThan(staple);
      expect(staple).toBeLessThan(finalCreate);
      expect(finalCreate).toBeLessThan(extract);
      expect(extract).toBeLessThan(extractedCodesign);
      expect(extractedCodesign).toBeLessThan(extractedStapler);
      expect(extractedStapler).toBeLessThan(archiveValidator);
      expect(archiveValidator).toBeLessThan(checksum);
      expect(zipFacts).toContain('extended local header:                          yes');
      expect(commands).not.toMatch(/upload|publish|aws|s3|rsync|scp/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aborts on post-extraction codesign failure without emitting or replacing a quartet', () => {
    // Catches trusting pre-archive verification when packaging has invalidated the emitted app.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-packaged-signature-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const log = join(root, 'commands.log');
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), [
        'output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done',
        'printf universal > "$output"',
      ]);
      executable(join(fake, 'ditto'), [
        'printf "ditto %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'if [ "$1" = -x ]; then',
        '  /usr/bin/ditto "$@"',
        '  : > "$4/Runtime Raiders Agent.app/Contents/.post-extraction"',
        '  exit 0',
        'fi',
        'exec /usr/bin/ditto "$@"',
      ]);
      executable(join(fake, 'codesign'), [
        'printf "codesign %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'verify=0; last=""',
        'for argument in "$@"; do [ "$argument" = --verify ] && verify=1; last="$argument"; done',
        'if [ "$verify" -eq 1 ] && [ -f "$last/Contents/.post-extraction" ]; then',
        '  printf "post-extraction codesign failure\\n" >&2',
        '  exit 86',
        'fi',
      ]);
      executable(join(fake, 'xcrun'), [
        'printf "xcrun %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
      ]);
      executable(join(fake, 'shasum'), [
        'printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"',
      ]);
      const fixture = disposableReleaseBuilder(root, { interceptAbsoluteDitto: true });
      const environment = {
        ...process.env,
        PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_TEST_LOG: log,
        RUNTIME_RAIDERS_TEST_DITTO: join(fake, 'ditto'),
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
      };

      const firstOutput = join(root, 'first-output');
      const first = invoke(
        fixture.build,
        releaseBuildArgs(
          fixture.releaseSHA,
          '--output', firstOutput,
          '--scratch-path', join(root, 'first-scratch'),
        ),
        environment,
      );
      expect(first.status).not.toBe(0);
      expect(first.stderr).toContain('post-extraction codesign failure');
      expect(existsSync(firstOutput)).toBe(false);
      const firstCommands = readFileSync(log, 'utf8').trim().split('\n');
      const firstVerifications = firstCommands.filter((line) => line.startsWith('codesign --verify '));
      expect(firstVerifications).toHaveLength(3);
      expect(firstVerifications[0]).not.toContain('/archive-validation.');
      expect(firstVerifications[1]).not.toContain('/archive-validation.');
      expect(firstVerifications[2]).toContain('/archive-validation.');
      expect(firstCommands.filter((line) => line.startsWith('xcrun notarytool submit '))).toHaveLength(1);

      writeFileSync(log, '');
      const existingOutput = join(root, 'existing-output');
      const quartet = [
        'install.sh',
        'runtime-raiders-agent.zip',
        'runtime-raiders-agent.zip.sha256',
        'runtime-raiders-agent.update.json',
      ];
      mkdirSync(existingOutput, { recursive: true });
      for (const target of quartet) writeFileSync(join(existingOutput, target), `old ${target}`);

      const replacement = invoke(
        fixture.build,
        releaseBuildArgs(
          fixture.releaseSHA,
          '--output', existingOutput,
          '--scratch-path', join(root, 'replacement-scratch'),
        ),
        environment,
      );
      expect(replacement.status).not.toBe(0);
      expect(replacement.stderr).toContain('post-extraction codesign failure');
      for (const target of quartet) {
        expect(readFileSync(join(existingOutput, target), 'utf8')).toBe(`old ${target}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the production validator to reject a name-correct ZIP with an unsafe Unix mode', () => {
    // Catches falling back to a name-only scan while a strict archive rule is violated.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-sidecar-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const releaseValidator = productionReleaseValidator(root);
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), [
        'if [ "$1" = stapler ] && [ "$2" = staple ]; then chmod 0777 "$3/Contents"; fi',
      ]);
      executable(join(fake, 'shasum'), ['exec /usr/bin/shasum "$@"']);
      const fixture = disposableReleaseBuilder(root);
      const output = join(root, 'output');

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_TEST_RELEASE_VALIDATOR: releaseValidator,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release archive shape validation failed');
      expect(existsSync(output)).toBe(false);
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
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['exit 1']);
      const output = join(root, 'output');
      const fixture = disposableReleaseBuilder(root);
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, 'runtime-raiders-agent.zip'), 'old zip');
      writeFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'old checksum');
      writeFileSync(join(output, 'install.sh'), 'old installer');
      const result = invoke(fixture.build, releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, 'scratch')), {
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

  it('restores the previous complete quartet after failure at each final output move', () => {
    // Catches rollback bookkeeping that protects only an early subset of final moves.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-output-transaction-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      executable(join(fake, 'mv'), [
        'printf "%s -> %s\\n" "$1" "$2" >> "$RUNTIME_RAIDERS_TEST_MV_LOG"',
        '[ "${2##*/}" = "$FAKE_MV_FAIL_TARGET" ] && [ "$(dirname "$2")" = "$RUNTIME_RAIDERS_TEST_OUTPUT" ] && exit 79',
        'exec /bin/mv "$@"',
      ]);
      const common = {
        ...process.env, PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
      };
      const fixture = disposableReleaseBuilder(root);
      const quartet = [
        'install.sh',
        'runtime-raiders-agent.zip',
        'runtime-raiders-agent.zip.sha256',
        'runtime-raiders-agent.update.json',
      ];
      for (const failedTarget of quartet) {
        const output = join(root, `output-${failedTarget.replaceAll('.', '-')}`);
        const moved = join(root, `moves-${failedTarget.replaceAll('.', '-')}.log`);
        mkdirSync(output, { recursive: true });
        for (const target of quartet) writeFileSync(join(output, target), `old ${target}`);

        const failed = invoke(
          fixture.build,
          releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, `scratch-${failedTarget}`)),
          {
            ...common,
            RUNTIME_RAIDERS_TEST_OUTPUT: output,
            RUNTIME_RAIDERS_TEST_MV_LOG: moved,
            FAKE_MV_FAIL_TARGET: failedTarget,
          },
        );

        expect(failed.status, failedTarget).not.toBe(0);
        for (const target of quartet) {
          expect(readFileSync(join(output, target), 'utf8'), `${failedTarget}: ${target}`).toBe(`old ${target}`);
        }
        const attemptedMove = readFileSync(moved, 'utf8').split('\n')
          .find((line) => line.endsWith(' -> ' + join(output, failedTarget)));
        expect(attemptedMove?.startsWith(output + '/.runtime-raiders-transaction.'), failedTarget).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses every orphan or symlinked quartet target without touching its contents or target', () => {
    // Catches a transaction that treats one member specially or follows an attacker-controlled target.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-unsafe-target-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      executable(join(fake, 'lipo'), ['output=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-output" ]; then output="$2"; shift 2; else shift; fi; done; printf universal > "$output"']);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const common = {
        ...process.env,
        PATH: fake + ':/usr/bin:/bin',
        RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
        RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
        RUNTIME_RAIDERS_TEAM_ID: teamId,
      };
      const fixture = disposableReleaseBuilder(root);
      const quartet = [
        'install.sh',
        'runtime-raiders-agent.zip',
        'runtime-raiders-agent.zip.sha256',
        'runtime-raiders-agent.update.json',
      ];
      for (const target of quartet) {
        const orphanOutput = join(root, `orphan-${target.replaceAll('.', '-')}`);
        mkdirSync(orphanOutput, { recursive: true });
        writeFileSync(join(orphanOutput, target), `orphan ${target}`);
        const orphan = invoke(
          fixture.build,
          releaseBuildArgs(fixture.releaseSHA, '--output', orphanOutput, '--scratch-path', join(root, `scratch-orphan-${target}`)),
          common,
        );
        expect(orphan.status, `${target}: ${orphan.stderr}`).not.toBe(0);
        expect(readdirSync(orphanOutput), target).toEqual([target]);
        expect(readFileSync(join(orphanOutput, target), 'utf8'), target).toBe(`orphan ${target}`);

        const symlinkOutput = join(root, `symlink-${target.replaceAll('.', '-')}`);
        const outside = join(root, `outside-${target.replaceAll('.', '-')}`);
        mkdirSync(symlinkOutput, { recursive: true });
        writeFileSync(outside, `outside ${target}`);
        symlinkSync(outside, join(symlinkOutput, target));
        const symlinked = invoke(
          fixture.build,
          releaseBuildArgs(fixture.releaseSHA, '--output', symlinkOutput, '--scratch-path', join(root, `scratch-symlink-${target}`)),
          common,
        );
        expect(symlinked.status, `${target}: ${symlinked.stderr}`).not.toBe(0);
        expect(readdirSync(symlinkOutput), target).toEqual([target]);
        expect(lstatSync(join(symlinkOutput, target)).isSymbolicLink(), target).toBe(true);
        expect(readFileSync(outside, 'utf8'), target).toBe(`outside ${target}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
