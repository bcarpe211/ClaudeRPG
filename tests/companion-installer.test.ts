import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installerTemplate = join(process.cwd(), 'companion/packaging/install.sh');
const releaseBuilder = join(process.cwd(), 'scripts/release/build-runtime-raiders-agent.sh');
const signedReleaseVerifier = join(process.cwd(), 'scripts/test/verify-runtime-raiders-signed-release.sh');
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

type BuildFixture = ReturnType<typeof buildFixture>;

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-beta-build-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const bin = join(root, 'fake-bin');
  const log = join(root, 'tools.log');
  const agentLog = join(root, 'agent.log');
  const copyHook = join(root, 'copy-hook');
  mkdirSync(join(repository, 'companion/packaging'), { recursive: true });
  mkdirSync(join(repository, 'scripts/release'), { recursive: true });
  mkdirSync(join(repository, 'scripts/test'), { recursive: true });
  mkdirSync(bin);
  cpSync(installerTemplate, join(repository, 'companion/packaging/install.sh'));
  cpSync(releaseBuilder, join(repository, 'scripts/release/build-runtime-raiders-agent.sh'));
  cpSync(signedReleaseVerifier, join(repository, 'scripts/test/verify-runtime-raiders-signed-release-real.sh'));
  executable(join(repository, 'scripts/test/verify-runtime-raiders-signed-release.sh'), [
    'script_directory=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)',
    '"$script_directory/verify-runtime-raiders-signed-release-real.sh" "$@"',
    'verifier_status=$?',
    '[ "$verifier_status" -eq 0 ] || exit "$verifier_status"',
    'case "${RR_BUILD_CONCURRENT_DRIFT:-}" in',
    '  dirty) printf "dirty\\n" >> "$RR_BUILD_CONCURRENT_FILE";;',
    '  head)',
    '    printf "head\\n" >> "$RR_BUILD_CONCURRENT_FILE"',
    '    /usr/bin/git -C "${RR_BUILD_CONCURRENT_FILE%/*}" add concurrent-source.txt',
    '    /usr/bin/git -C "${RR_BUILD_CONCURRENT_FILE%/*}" commit -qm concurrent-drift;;',
    'esac',
    'case "${RR_BUILD_STAGED_DRIFT:-}" in',
    '  member-set) printf "unexpected\\n" > "$1/unexpected";;',
    '  metadata) /bin/chmod 600 "$1/install.sh";;',
    '  size) printf "x" >> "$1/version";;',
    '  hash) printf "X" | /bin/dd of="$1/install.sh" bs=1 count=1 conv=notrunc 2>/dev/null;;',
    'esac',
  ]);
  writeFileSync(join(repository, 'companion/RELEASE'), 'format=1\ncompanion_version=0.4.0\n');
  writeFileSync(join(repository, 'concurrent-source.txt'), 'reviewed\n');
  writeFileSync(log, '');
  writeFileSync(agentLog, '');
  executable(copyHook, [
    '[ "$1" = release-summary.txt ] || exit 0',
    'printf "X" | /bin/dd of="$2/install.sh" bs=1 count=1 conv=notrunc 2>/dev/null',
  ]);

  executable(join(bin, 'swift'), [
    'printf "swift" >> "$RR_BUILD_LOG"; for value in "$@"; do printf " <%s>" "$value" >> "$RR_BUILD_LOG"; done; printf "\\n" >> "$RR_BUILD_LOG"',
    'arch=""; scratch=""; product=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --arch) arch=$2; shift 2;;',
    '    --scratch-path) scratch=$2; shift 2;;',
    '    --product) product=$2; shift 2;;',
    '    *) shift;;',
    '  esac',
    'done',
    '[ "$product" = raiders ] && { [ "$arch" = arm64 ] || [ "$arch" = x86_64 ]; } || exit 64',
    'output="$scratch/$arch-apple-macosx/release/raiders"',
    'mkdir -p "${output%/*}"',
    'cat > "$output" <<\'AGENT\'',
    '#!/bin/sh',
    'set -eu',
    `printf 'agent:%s\\n' "\${1:-status}" >> '${agentLog}'`,
    'case "${1:-status}" in',
    '  status) printf \'{"activationState":"disabled","companionVersion":"0.4.0"}\\n\';;',
    '  daemon) exit 0;;',
    '  update)',
    '    response=${RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE:-}',
    '    [ -n "$response" ] && [ "$(cat "$response")" = \'{"version":"0.4.0"}\' ] || exit 70',
    '    printf \'Runtime Raiders 0.4.0 is current.\\n\';;',
    '  on) exit 97;;',
    '  *) exit 64;;',
    'esac',
    'AGENT',
    'if [ "${RR_BUILD_OVERSIZED_BINARY:-0}" = 1 ]; then /bin/dd if=/dev/urandom bs=1048576 count=9 >> "$output" 2>/dev/null; fi',
    'chmod 700 "$output"',
  ]);
  executable(join(bin, 'lipo'), [
    'printf "lipo" >> "$RR_BUILD_LOG"; for value in "$@"; do printf " <%s>" "$value" >> "$RR_BUILD_LOG"; done; printf "\\n" >> "$RR_BUILD_LOG"',
    'if [ -n "${RR_VERIFY_MUTATE_RELEASE:-}" ] && [ ! -e "$RR_VERIFY_MUTATION_MARKER" ]; then',
    '  case "${RR_VERIFY_MUTATION:-}" in',
    '    member-set) printf "unexpected\\n" > "$RR_VERIFY_MUTATE_RELEASE/unexpected";;',
    '    metadata) /bin/chmod 600 "$RR_VERIFY_MUTATE_RELEASE/install.sh";;',
    '    size) printf "x" >> "$RR_VERIFY_MUTATE_RELEASE/version";;',
    '    hash) printf "X" | /bin/dd of="$RR_VERIFY_MUTATE_RELEASE/install.sh" bs=1 count=1 conv=notrunc 2>/dev/null;;',
    '    *) exit 64;;',
    '  esac',
    '  : > "$RR_VERIFY_MUTATION_MARKER"',
    'fi',
    'if [ "$1" = -create ]; then',
    '  first=$2; output=""',
    '  while [ "$#" -gt 0 ]; do [ "$1" != -output ] || { output=$2; break; }; shift; done',
    '  [ -n "$output" ] || exit 64; cp "$first" "$output"; chmod 700 "$output"',
    'else',
    '  [ "$2" = -verify_arch ] && [ "$3" = arm64 ] && [ "$4" = x86_64 ] || exit 64',
    'fi',
  ]);
  executable(join(bin, 'codesign'), [
    'printf "codesign" >> "$RR_BUILD_LOG"; for value in "$@"; do printf " <%s>" "$value" >> "$RR_BUILD_LOG"; done; printf "\\n" >> "$RR_BUILD_LOG"',
    'if [ "${1:-}" = -dv ]; then',
    '  printf "Executable=fake\\nIdentifier=com.redlattice.runtime-raiders-agent\\nFormat=app bundle with Mach-O universal (arm64 x86_64)\\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded\\nSignature size=1\\nAuthority=Developer ID Application: Runtime Raiders (ABCDE12345)\\nTeamIdentifier=ABCDE12345\\nRuntime Version=26.0.0\\nTimestamp=Aug 18, 2026 at 12:00:00\\n" >&2',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = --verify ] && [ "${2:-}" = --strict ]; then',
    '  [ "$#" -eq 4 ] || { echo "codesign fake rejects split requirement arguments" >&2; exit 65; }',
    `  [ "$3" = '-R=identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"' ] || { echo "codesign fake requires inline requirement expression" >&2; exit 65; }`,
    'fi',
    'case " $* " in',
    '  *" --sign "*)',
    '    if [ "${RR_BUILD_MUTATE_BUNDLE:-0}" = 1 ]; then',
    '      last=""; for last in "$@"; do :; done',
    '      /usr/bin/plutil -replace CFBundleVersion -string 9.9.9 "$last/Contents/Info.plist"',
    '    fi;;',
    'esac',
  ]);
  executable(join(bin, 'spctl'), [
    'printf "spctl" >> "$RR_BUILD_LOG"; for value in "$@"; do printf " <%s>" "$value" >> "$RR_BUILD_LOG"; done; printf "\\n" >> "$RR_BUILD_LOG"',
    'last=""; for last in "$@"; do :; done',
    'printf "%s: accepted\\nsource=Notarized Developer ID\\n" "$last" >&2',
  ]);
  executable(join(bin, 'xcrun'), [
    'printf "xcrun" >> "$RR_BUILD_LOG"; for value in "$@"; do printf " <%s>" "$value" >> "$RR_BUILD_LOG"; done; printf "\\n" >> "$RR_BUILD_LOG"',
    'case " $* " in *" notarytool submit "*) printf "id: 00000000-0000-4000-8000-000000000001\\nstatus: Accepted\\n";; esac',
  ]);

  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'runtime-raiders-test@example.invalid'],
    ['config', 'user.name', 'Runtime Raiders Test'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }

  return {
    root,
    repository,
    log,
    agentLog,
    copyHook,
    output: join(repository, 'dist/runtime-raiders-beta-0.4.0'),
    environment: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      RR_BUILD_LOG: log,
      RR_BUILD_CONCURRENT_FILE: join(repository, 'concurrent-source.txt'),
      RR_VERIFY_MUTATION_MARKER: join(root, 'verify-mutation.done'),
      RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Runtime Raiders (ABCDE12345)',
      RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-test-profile',
      RUNTIME_RAIDERS_TEAM_ID: 'ABCDE12345',
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_TEST_ROOT: realpathSync(repository),
      RUNTIME_RAIDERS_TEST_SWIFT: realpathSync(join(bin, 'swift')),
      RUNTIME_RAIDERS_TEST_LIPO: realpathSync(join(bin, 'lipo')),
      RUNTIME_RAIDERS_TEST_CODESIGN: realpathSync(join(bin, 'codesign')),
      RUNTIME_RAIDERS_TEST_SPCTL: realpathSync(join(bin, 'spctl')),
      RUNTIME_RAIDERS_TEST_XCRUN: realpathSync(join(bin, 'xcrun')),
    } as NodeJS.ProcessEnv,
  };
}

function runBuild(value: BuildFixture, environment: NodeJS.ProcessEnv = value.environment) {
  return spawnSync('/bin/bash', ['scripts/release/build-runtime-raiders-agent.sh'], {
    cwd: value.repository,
    env: environment,
    encoding: 'utf8',
  });
}

function runSignedVerifier(value: BuildFixture, environment: NodeJS.ProcessEnv = value.environment) {
  return spawnSync('/bin/bash', ['scripts/test/verify-runtime-raiders-signed-release.sh', value.output], {
    cwd: value.repository,
    env: environment,
    encoding: 'utf8',
  });
}

function commitFixture(value: BuildFixture, message: string): string {
  for (const args of [['add', 'companion/RELEASE', 'concurrent-source.txt'], ['commit', '-qm', message]]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: value.repository, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  return spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: value.repository,
    encoding: 'utf8',
  }).stdout.trim();
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

function enrollmentObject(): Record<string, unknown> {
  return {
    version: 1,
    device_id: '00000000-0000-4000-8000-000000000001',
    device_token: token,
    dedupe_secret: secret,
    server_url: 'https://raiders.redlattice.com',
    cutover_at: 1_800_000_000_000,
    enabled_surfaces: ['codex_desktop', 'codex_cli'],
  };
}

function enrollment(value: Record<string, unknown> = enrollmentObject()): string {
  return JSON.stringify(value) + '\n';
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
    '    printf "%s/unpacked/Runtime Raiders Agent.app\\n" "${output%/*}" > "$RR_EXPECT_CANDIDATE"',
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
    'candidate=""; for candidate do :; done',
    'IFS= read -r expected_candidate < "$RR_EXPECT_CANDIDATE"',
    '[ "$candidate" = "$expected_candidate" ] || exit 65',
    'if [ "$#" -eq 5 ] && [ "$1" = --verify ] && [ "$2" = --deep ] && [ "$3" = --strict ] && [ "$4" = --verbose=2 ]; then',
    '  printf "codesign:deep\\n" >> "$RR_EVENT_LOG"; exit 0',
    'fi',
    'if [ "$#" -eq 4 ] && [ "$1" = --verify ] && [ "$2" = --strict ]; then',
    `  expected_requirement='-R=identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$RR_TEAM_ID"'"'`,
    '  [ "$3" = "$expected_requirement" ] || exit 65',
    '  printf "codesign:requirement\\n" >> "$RR_EVENT_LOG"; exit 0',
    'fi',
    'exit 64',
  ]);
  executable(join(bin, 'spctl'), [
    '[ "$#" -eq 5 ] && [ "$1" = --assess ] && [ "$2" = --type ] && [ "$3" = execute ] && [ "$4" = --verbose=2 ] || exit 64',
    'IFS= read -r expected_candidate < "$RR_EXPECT_CANDIDATE"',
    '[ "$5" = "$expected_candidate" ] || exit 65',
    '[ "${RR_FAIL_SPCTL:-0}" != 1 ] || exit 1',
    'printf "spctl:assess\\n" >> "$RR_EVENT_LOG"',
  ]);
  executable(join(bin, 'launchctl'), [
    'printf "launchctl:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    'case "${1:-}" in',
    '  bootout)',
    '    [ "$#" -eq 2 ] && [ "$2" = "gui/$RR_OWNER/com.redlattice.runtime-raiders-agent" ] || exit 64',
    '    : > "$RR_BOOTOUT_OK"; rm -f "$RR_RUNNING"; exit 0;;',
    '  bootstrap)',
    '    [ "$#" -eq 3 ] && [ "$2" = "gui/$RR_OWNER" ] && [ "$3" = "$RR_PLIST" ] || exit 64',
    '    if [ "${RR_FAIL_FIRST_BOOTSTRAP:-0}" = 1 ] && [ ! -e "$RR_BOOTSTRAP_FAILED" ]; then',
    '      : > "$RR_BOOTSTRAP_FAILED"; exit 75',
    '    fi',
    '    if [ "${RR_FAIL_ROLLBACK_BOOTSTRAP:-0}" = 1 ] && [ -e "$RR_BOOTSTRAP_FAILED" ]; then exit 76; fi',
    '    : > "$RR_RUNNING"; exit 0;;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'stty'), [
    'printf "tty:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    '[ "${1:-}" != -g ] || printf saved',
  ]);
  executable(join(bin, 'uuidgen'), ['printf "%s\\n" "${RR_UUID:-00000000-0000-4000-8000-000000000001}"']);
  executable(join(bin, 'mv'), [
    '[ "$#" -eq 2 ] || exec /bin/mv "$@"',
    'source=$1; destination=$2; boundary=',
    'case "$destination" in',
    '  */old.app) boundary=backup-app;;',
    '  */old.plist) boundary=backup-plist;;',
    '  */old.shim) boundary=backup-shim;;',
    'esac',
    'if [ "$source" != "$destination" ]; then',
    '  case "$source:$destination" in',
    '    */old.app:"$RR_APP") boundary=restore-app;;',
    '    */old.plist:"$RR_PLIST") boundary=restore-plist;;',
    '    */old.shim:"$RR_SHIM") boundary=restore-shim;;',
    '    *:"$RR_APP") boundary=replace-app;;',
    '    *:"$RR_PLIST") boundary=replace-plist;;',
    '    *:"$RR_SHIM") boundary=replace-shim;;',
    '  esac',
    'fi',
    'if [ -n "$boundary" ]; then',
    '  printf "mv:%s\\n" "$boundary" >> "$RR_EVENT_LOG"',
    '  [ -e "$RR_BOOTOUT_OK" ] || exit 66',
    'fi',
    'if [ -n "$boundary" ] && { [ "${RR_FAIL_MV_BOUNDARY:-}" = "$boundary" ] || [ "${RR_FAIL_RESTORE_BOUNDARY:-}" = "$boundary" ]; }; then exit 74; fi',
    '/bin/mv "$source" "$destination"',
    'if [ -n "$boundary" ] && [ "${RR_SIGNAL_AFTER_MV_BOUNDARY:-}" = "$boundary" ]; then kill -TERM "$PPID"; fi',
  ]);
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
    candidate, eventLog, argvLog, enrollmentStdin, enrollmentResponse, running,
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
      RR_APP: app,
      RR_PLIST: plistPath,
      RR_SHIM: shim,
      RR_OWNER: String(process.getuid!()),
      RR_BOOTOUT_OK: join(root, 'bootout-ok'),
      RR_EXPECT_CANDIDATE: join(root, 'expected-candidate'),
      RR_BOOTSTRAP_FAILED: join(root, 'bootstrap-failed'),
      RR_TEAM_ID: teamId,
      RR_TTY: tty,
      RR_FAKE_BIN: bin,
    } as NodeJS.ProcessEnv,
  };
}

function renderInstaller(value: Fixture, mutate: (source: string) => string = (source) => source): string {
  const fake = value.environment.RR_FAKE_BIN!;
  const tty = value.environment.RR_TTY!;
  const rendered = join(value.root, 'install-rendered.sh');
  const validator = join(value.root, 'old-validator');
  executable(validator, ['exit 0']);
  const source = mutate(readFileSync(installerTemplate, 'utf8'))
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
    .replaceAll('/bin/mv', join(fake, 'mv'))
    .replaceAll('/usr/bin/stty', join(fake, 'stty'))
    .replaceAll('/usr/bin/uuidgen', join(fake, 'uuidgen'))
    .replaceAll('/dev/tty', tty);
  writeFileSync(rendered, source, { mode: 0o700 });
  return rendered;
}

function run(value: Fixture, shell = '/bin/sh', mutate?: (source: string) => string) {
  return spawnSync(shell, [renderInstaller(value, mutate)], {
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

function installedTargets(value: Fixture): Record<string, unknown> {
  return {
    app: treeSnapshot(value.app),
    plist: existsSync(value.plist) ? readFileSync(value.plist).toString('base64') : null,
    shim: existsSync(value.shim) ? readFileSync(value.shim).toString('base64') : null,
  };
}

function recoveryDirectories(value: Fixture): string[] {
  const launchAgents = join(value.home, 'Library/LaunchAgents');
  return [
    ...(existsSync(value.support)
      ? readdirSync(value.support).filter((name) => name.startsWith('.runtime-raiders-install.')).map((name) => join(value.support, name))
      : []),
    ...(existsSync(launchAgents)
      ? readdirSync(launchAgents).filter((name) => name.startsWith('.runtime-raiders-backup.')).map((name) => join(launchAgents, name))
      : []),
  ];
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Runtime Raiders release build', () => {
  it('real codesign parses inline requirement expressions instead of treating them as paths', () => {
    const separate = spawnSync('/usr/bin/codesign', [
      '--verify', '--strict', '-R', 'anchor apple', '/bin/ls',
    ], { encoding: 'utf8' });
    const inline = spawnSync('/usr/bin/codesign', [
      '--verify', '--strict', '-R=anchor apple', '/bin/ls',
    ], { encoding: 'utf8' });
    expect(separate.stderr).toContain('anchor apple: No such file or directory');
    expect(separate.stderr).toContain('invalid requirement specification');
    expect(inline.stderr).not.toContain('No such file or directory');
    expect(inline.stderr).not.toContain('invalid requirement specification');
  });

  it('signed verifier passes its designated requirement in codesign inline form', () => {
    const value = buildFixture();
    const result = runBuild(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(value.log, 'utf8')).toContain(
      'codesign <--verify> <--strict> <-R=identifier "com.redlattice.runtime-raiders-agent"',
    );
  });

  it.each([
    ['RUNTIME_RAIDERS_CODESIGN_IDENTITY'],
    ['RUNTIME_RAIDERS_NOTARY_PROFILE'],
    ['RUNTIME_RAIDERS_TEAM_ID'],
  ])('release build requires %s before invoking any build tool', (missing) => {
    const value = buildFixture();
    const environment = { ...value.environment };
    delete environment[missing];
    const result = runBuild(value, environment);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(`${missing} is required`);
    expect(readFileSync(value.log, 'utf8')).toBe('');
  });

  it('release build refuses dirty tracked source before invoking any build tool', () => {
    const value = buildFixture();
    writeFileSync(join(value.repository, 'companion/packaging/install.sh'), '\n# dirty tracked source\n', { flag: 'a' });
    const result = runBuild(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('tracked worktree is not clean');
    expect(readFileSync(value.log, 'utf8')).toBe('');
  });

  it('release build production mode ignores PATH-shadowed Apple tools', () => {
    const value = buildFixture();
    const environment = { ...value.environment };
    for (const key of [
      'RUNTIME_RAIDERS_TEST_MODE',
      'RUNTIME_RAIDERS_TEST_ROOT',
      'RUNTIME_RAIDERS_TEST_SWIFT',
      'RUNTIME_RAIDERS_TEST_LIPO',
      'RUNTIME_RAIDERS_TEST_CODESIGN',
      'RUNTIME_RAIDERS_TEST_SPCTL',
      'RUNTIME_RAIDERS_TEST_XCRUN',
    ]) delete environment[key];
    const result = runBuild(value, environment);
    expect(result.status).not.toBe(0);
    expect(readFileSync(value.log, 'utf8')).toBe('');
    expect(existsSync(value.output)).toBe(false);
  });

  it('release build accepts only absolute owned test tools in explicit test mode', () => {
    const value = buildFixture();
    const result = runBuild(value, {
      ...value.environment,
      RUNTIME_RAIDERS_TEST_LIPO: 'lipo',
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('test tool configuration is invalid');
    expect(readFileSync(value.log, 'utf8')).toBe('');
  });

  it('release build produces one universal signed notarized app and only the beta release files', () => {
    const value = buildFixture();
    const result = runBuild(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);

    expect(readdirSync(value.output).sort()).toEqual([
      'install.sh',
      'release-summary.txt',
      'runtime-raiders-agent.zip',
      'version',
    ]);
    expect(readFileSync(join(value.output, 'version'), 'utf8')).toBe('{"version":"0.4.0"}\n');

    const installer = readFileSync(join(value.output, 'install.sh'), 'utf8');
    expect(installer).toContain("COMPANION_VERSION='0.4.0'");
    expect(installer).toContain("TEAM_ID='ABCDE12345'");
    expect(installer).not.toContain('__RUNTIME_RAIDERS_');
    expect(installer).not.toMatch(/release.validator|public.checksum|update.manifest/i);

    const extracted = join(value.root, 'extracted');
    mkdirSync(extracted);
    const unpacked = spawnSync('/usr/bin/ditto', [
      '-x', '-k', join(value.output, 'runtime-raiders-agent.zip'), extracted,
    ], { encoding: 'utf8' });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    expect(readdirSync(extracted)).toEqual(['Runtime Raiders Agent.app']);
    const info = join(extracted, 'Runtime Raiders Agent.app/Contents/Info.plist');
    for (const [key, expected] of [
      ['CFBundleIdentifier', 'com.redlattice.runtime-raiders-agent'],
      ['CFBundleExecutable', 'runtime-raiders-agent'],
      ['CFBundleShortVersionString', '0.4.0'],
      ['CFBundleVersion', '0.4.0'],
    ]) {
      const checked = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info], { encoding: 'utf8' });
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout.trim()).toBe(expected);
    }

    const commands = readFileSync(value.log, 'utf8');
    expect(commands.match(/^swift .*<--arch> <arm64>.*<--product> <raiders>$/gm)).toHaveLength(1);
    expect(commands.match(/^swift .*<--arch> <x86_64>.*<--product> <raiders>$/gm)).toHaveLength(1);
    expect(commands).not.toMatch(/launcher|validator/);
    expect(commands).toMatch(/^lipo <-create> .*<-output> /m);
    expect(commands).toMatch(/^lipo <.*runtime-raiders-agent> <-verify_arch> <arm64> <x86_64>$/m);
    expect(commands).toMatch(/^codesign <--force> <--options> <runtime> <--timestamp> <--sign> /m);
    expect(commands).toMatch(/^codesign <--verify> <--deep> <--strict> <--verbose=2> /m);
    expect(commands).toMatch(/^xcrun <notarytool> <submit> .*<--keychain-profile> <runtime-raiders-test-profile> <--wait>$/m);
    expect(commands).toMatch(/^xcrun <stapler> <staple> /m);
    expect(commands).toMatch(/^xcrun <stapler> <validate> /m);
    expect(commands).toMatch(/^spctl <--assess> <--type> <execute> <--verbose=2> /m);

    const summary = readFileSync(join(value.output, 'release-summary.txt'), 'utf8');
    const head = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: value.repository, encoding: 'utf8' }).stdout.trim();
    expect(summary).toContain(`git_sha=${head}`);
    expect(summary).toContain('companion_version=0.4.0');
    expect(summary).toContain('team_id=ABCDE12345');
    expect(summary).toContain('notarization=Accepted');
    expect(summary).toContain('hardened_runtime=true');
    expect(summary).toContain('secure_timestamp=true');
    expect(summary).toMatch(/runtime-raiders-agent\.zip_sha256=[0-9a-f]{64}/);
    expect(summary).toMatch(/install\.sh_bytes=[1-9][0-9]*/);
    expect(summary).not.toMatch(/sequence|generation|launcher|validator|public.checksum|update.manifest/i);
    expect(readFileSync(value.agentLog, 'utf8')).toMatch(/agent:status[\s\S]*agent:update/);
  });

  it.each(['dirty', 'head'])('release build refuses concurrent %s drift after verification', (drift) => {
    const value = buildFixture();
    const result = runBuild(value, { ...value.environment, RR_BUILD_CONCURRENT_DRIFT: drift });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reviewed source changed during release build');
    expect(existsSync(value.output)).toBe(false);
  });

  it.each(['member-set', 'metadata', 'size', 'hash'])(
    'release build refuses staged %s drift after signed verification',
    (drift) => {
      const value = buildFixture();
      const result = runBuild(value, { ...value.environment, RR_BUILD_STAGED_DRIFT: drift });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('staged release changed after signed verification');
      expect(existsSync(value.output)).toBe(false);
      expect(readFileSync(value.agentLog, 'utf8')).toMatch(/agent:status[\s\S]*agent:update/);
    },
  );

  it('release build rejects an archive larger than the installer 8 MiB limit', () => {
    const value = buildFixture();
    const result = runBuild(value, { ...value.environment, RR_BUILD_OVERSIZED_BINARY: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release archive exceeds 8388608 bytes');
    expect(existsSync(value.output)).toBe(false);
  });

  it('release build rejects any installer placeholder left after the two allowed substitutions', () => {
    const value = buildFixture();
    writeFileSync(
      join(value.repository, 'companion/packaging/install.sh'),
      '\n__RUNTIME_RAIDERS_RETIRED_PLACEHOLDER__\n',
      { flag: 'a' },
    );
    const committed = spawnSync('/usr/bin/git', ['add', 'companion/packaging/install.sh'], { cwd: value.repository });
    expect(committed.status).toBe(0);
    const commit = spawnSync('/usr/bin/git', ['commit', '-qm', 'placeholder fixture'], { cwd: value.repository });
    expect(commit.status).toBe(0);
    const result = runBuild(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unrendered installer placeholder');
    expect(existsSync(value.output)).toBe(false);
  });

  it('release build rejects a signed bundle whose embedded version drifts', () => {
    const value = buildFixture();
    const result = runBuild(value, { ...value.environment, RR_BUILD_MUTATE_BUNDLE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bundle version does not match companion/RELEASE');
    expect(existsSync(value.output)).toBe(false);
  });

  it('signed verifier production mode ignores PATH-shadowed Apple tools', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    writeFileSync(value.log, '');
    const environment = { ...value.environment };
    for (const key of [
      'RUNTIME_RAIDERS_TEST_MODE',
      'RUNTIME_RAIDERS_TEST_ROOT',
      'RUNTIME_RAIDERS_TEST_SWIFT',
      'RUNTIME_RAIDERS_TEST_LIPO',
      'RUNTIME_RAIDERS_TEST_CODESIGN',
      'RUNTIME_RAIDERS_TEST_SPCTL',
      'RUNTIME_RAIDERS_TEST_XCRUN',
    ]) delete environment[key];
    const result = runSignedVerifier(value, environment);
    expect(result.status).not.toBe(0);
    expect(readFileSync(value.log, 'utf8')).toBe('');
  });

  it('signed verifier refuses the copy hook outside explicit test mode', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    const environment: NodeJS.ProcessEnv = {
      ...value.environment,
      RUNTIME_RAIDERS_TEST_COPY_HOOK: value.copyHook,
    };
    for (const key of [
      'RUNTIME_RAIDERS_TEST_MODE',
      'RUNTIME_RAIDERS_TEST_ROOT',
      'RUNTIME_RAIDERS_TEST_LIPO',
      'RUNTIME_RAIDERS_TEST_CODESIGN',
      'RUNTIME_RAIDERS_TEST_SPCTL',
      'RUNTIME_RAIDERS_TEST_XCRUN',
    ]) delete environment[key];
    const result = runSignedVerifier(value, environment);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('signed verifier test tool configuration is invalid');
  });

  it('signed verifier refuses a group-writable release directory', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    chmodSync(value.output, 0o770);
    const result = runSignedVerifier(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release directory must not be group or world writable');
  });

  it('signed verifier requires a clean reviewed checkout', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    appendFileSync(join(value.repository, 'concurrent-source.txt'), 'dirty\n');
    const result = runSignedVerifier(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reviewed source must be clean');
  });

  it('signed verifier requires the exact companion RELEASE version from current HEAD', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    writeFileSync(join(value.repository, 'companion/RELEASE'), 'format=1\ncompanion_version=0.4.1\n');
    const head = commitFixture(value, 'advance release metadata');
    const summary = join(value.output, 'release-summary.txt');
    writeFileSync(summary, readFileSync(summary, 'utf8').replace(/^git_sha=.*$/m, `git_sha=${head}`));
    const result = runSignedVerifier(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release files do not match companion/RELEASE');
  });

  it('signed verifier requires summary Git SHA to equal current reviewed HEAD', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    const summary = join(value.output, 'release-summary.txt');
    writeFileSync(summary, readFileSync(summary, 'utf8').replace(/^git_sha=.*$/m, `git_sha=${'f'.repeat(40)}`));
    const result = runSignedVerifier(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release summary does not match reviewed HEAD');
  });

  it.each(['member-set', 'metadata', 'size', 'hash'])(
    'signed verifier rejects source release %s drift after using private copies',
    (mutation) => {
      const value = buildFixture();
      expect(runBuild(value).status).toBe(0);
      writeFileSync(value.agentLog, '');
      const result = runSignedVerifier(value, {
        ...value.environment,
        RR_VERIFY_MUTATE_RELEASE: value.output,
        RR_VERIFY_MUTATION: mutation,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release directory changed during signed verification');
      expect(readFileSync(value.agentLog, 'utf8')).toMatch(/agent:status[\s\S]*agent:update/);
    },
  );

  it('signed verifier rejects an early member changed while later members are copied', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    writeFileSync(value.agentLog, '');
    const result = runSignedVerifier(value, {
      ...value.environment,
      RUNTIME_RAIDERS_TEST_COPY_HOOK: value.copyHook,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release directory changed while making private copies');
    expect(result.stdout).not.toContain('Verified local Runtime Raiders beta');
    expect(readFileSync(value.agentLog, 'utf8')).toBe('');
  });
});

describe('Runtime Raiders reinstall-safe installer', () => {
  it('passes one exact inline designated requirement to codesign', () => {
    const value = fixture();
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(value.argvLog, 'utf8')).toContain(
      'codesign-argv <--verify> <--strict> <-R=identifier "com.redlattice.runtime-raiders-agent"',
    );
  });

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

  it('reuses every nonempty unique subset of runtime-supported surfaces', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const configured = { ...enrollmentObject(), enabled_surfaces: ['codex_desktop'] };
    writeFileSync(join(value.state, 'enrollment.json'), enrollment(configured), { mode: 0o600 });
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value)).not.toContain('curl:enroll');
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).toBe(enrollment(configured));
  });

  it.each([
    ['extra key', (wire: Record<string, unknown>) => { wire.extra = true; }],
    ['string version', (wire: Record<string, unknown>) => { wire.version = '1'; }],
    ['wrong version', (wire: Record<string, unknown>) => { wire.version = 2; }],
    ['missing key', (wire: Record<string, unknown>) => { delete wire.device_token; }],
    ['non-UUID device ID', (wire: Record<string, unknown>) => { wire.device_id = 'deadbeef'; }],
    ['numeric token', (wire: Record<string, unknown>) => { wire.device_token = 4_242; }],
    ['bad token alphabet', (wire: Record<string, unknown>) => { wire.device_token = `${'T'.repeat(42)}!`; }],
    ['short token', (wire: Record<string, unknown>) => { wire.device_token = 'T'.repeat(42); }],
    ['uppercase secret', (wire: Record<string, unknown>) => { wire.dedupe_secret = 'A'.repeat(64); }],
    ['short secret', (wire: Record<string, unknown>) => { wire.dedupe_secret = 'a'.repeat(62); }],
    ['wrong server URL', (wire: Record<string, unknown>) => { wire.server_url = 'https://example.invalid'; }],
    ['negative cutover', (wire: Record<string, unknown>) => { wire.cutover_at = -1; }],
    ['unsafe cutover', (wire: Record<string, unknown>) => { wire.cutover_at = 9_007_199_254_740_992; }],
    ['string cutover', (wire: Record<string, unknown>) => { wire.cutover_at = '1800000000000'; }],
    ['empty surfaces', (wire: Record<string, unknown>) => { wire.enabled_surfaces = []; }],
    ['duplicate surfaces', (wire: Record<string, unknown>) => { wire.enabled_surfaces = ['codex_cli', 'codex_cli']; }],
    ['unsupported surface', (wire: Record<string, unknown>) => { wire.enabled_surfaces = ['codex_desktop', 'terminal']; }],
    ['non-array surfaces', (wire: Record<string, unknown>) => { wire.enabled_surfaces = 'codex_desktop'; }],
  ] as const)('invalid existing enrollment (%s) cannot suppress a fresh prompt', (_, mutate) => {
    const value = fixture();
    writeExistingInstall(value, false);
    const malformed = enrollmentObject();
    mutate(malformed);
    writeFileSync(join(value.state, 'enrollment.json'), enrollment(malformed), { mode: 0o600 });
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value).filter((line) => line === 'curl:enroll')).toHaveLength(1);
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(true);
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).toBe(enrollment());
  });

  it.each([
    ['oversized JSON', (path: string) => {
      writeFileSync(path, enrollment().padEnd(65_537, ' '), { mode: 0o600 });
    }],
    ['non-JSON plist', (path: string) => {
      writeFileSync(path, enrollment(), { mode: 0o600 });
      const converted = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', path], { encoding: 'utf8' });
      expect(converted.status, converted.stderr).toBe(0);
    }],
  ] as const)('%s cannot suppress a fresh enrollment prompt', (_, writeMalformed) => {
    const value = fixture();
    writeExistingInstall(value, false);
    writeMalformed(join(value.state, 'enrollment.json'));
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value).filter((line) => line === 'curl:enroll')).toHaveLength(1);
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).toBe(enrollment());
  });

  it.each([
    ['extra key', (wire: Record<string, unknown>, _value: Fixture) => { wire.extra = true; }],
    ['missing key', (wire: Record<string, unknown>, _value: Fixture) => { delete wire.device_token; }],
    ['numeric token', (wire: Record<string, unknown>, _value: Fixture) => { wire.device_token = 4_242; }],
    ['bad token alphabet', (wire: Record<string, unknown>, _value: Fixture) => { wire.device_token = `${'T'.repeat(42)}!`; }],
    ['short token', (wire: Record<string, unknown>, _value: Fixture) => { wire.device_token = 'T'.repeat(42); }],
    ['uppercase secret', (wire: Record<string, unknown>, _value: Fixture) => { wire.dedupe_secret = 'A'.repeat(64); }],
    ['short secret', (wire: Record<string, unknown>, _value: Fixture) => { wire.dedupe_secret = 'a'.repeat(62); }],
    ['wrong server URL', (wire: Record<string, unknown>, _value: Fixture) => { wire.server_url = 'https://example.invalid'; }],
    ['negative cutover', (wire: Record<string, unknown>, _value: Fixture) => { wire.cutover_at = -1; }],
    ['unsafe cutover', (wire: Record<string, unknown>, _value: Fixture) => { wire.cutover_at = 9_007_199_254_740_992; }],
    ['string cutover', (wire: Record<string, unknown>, _value: Fixture) => { wire.cutover_at = '1800000000000'; }],
    ['empty surfaces', (wire: Record<string, unknown>, _value: Fixture) => { wire.enabled_surfaces = []; }],
    ['duplicate surfaces', (wire: Record<string, unknown>, _value: Fixture) => { wire.enabled_surfaces = ['codex_cli', 'codex_cli']; }],
    ['unsupported surface', (wire: Record<string, unknown>, _value: Fixture) => { wire.enabled_surfaces = ['codex_desktop', 'terminal']; }],
    ['non-array surfaces', (wire: Record<string, unknown>, _value: Fixture) => { wire.enabled_surfaces = 'codex_desktop'; }],
    ['invalid generated UUID', (_wire: Record<string, unknown>, value: Fixture) => { value.environment.RR_UUID = 'deadbeef'; }],
  ] as const)('rejects malformed fresh enrollment response (%s) before stopping launchd', (_, mutate) => {
    const value = fixture();
    const wire = {
      device_token: token,
      dedupe_secret: secret,
      server_url: 'https://raiders.redlattice.com',
      cutover_at: 1_800_000_000_000,
      enabled_surfaces: ['codex_desktop', 'codex_cli'],
    } as Record<string, unknown>;
    mutate(wire, value);
    writeFileSync(value.enrollmentResponse, JSON.stringify(wire) + '\n');
    const result = run(value);
    expect(result.status).not.toBe(0);
    expectNoBootout(value);
    expect(existsSync(join(value.state, 'enrollment.json'))).toBe(false);
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

  it.each(['backup-app', 'backup-plist', 'backup-shim'] as const)(
    'a %s move failure leaves untouched targets intact, restores moved targets, and restarts the old app',
    (boundary) => {
      const value = fixture();
      writeExistingInstall(value, true);
      const before = installedTargets(value);
      value.environment.RR_FAIL_MV_BOUNDARY = boundary;
      const result = run(value);
      expect(result.status).not.toBe(0);
      expect(installedTargets(value)).toEqual(before);
      expect(existsSync(value.running)).toBe(true);
      expect(recoveryDirectories(value)).toHaveLength(0);
    },
  );

  it.each(['replace-app', 'replace-plist', 'replace-shim'] as const)(
    'a %s move failure restores every old target and restarts the old app',
    (boundary) => {
      const value = fixture();
      writeExistingInstall(value, true);
      const before = installedTargets(value);
      value.environment.RR_FAIL_MV_BOUNDARY = boundary;
      const result = run(value);
      expect(result.status).not.toBe(0);
      expect(installedTargets(value)).toEqual(before);
      expect(existsSync(value.running)).toBe(true);
      expect(recoveryDirectories(value)).toHaveLength(0);
    },
  );

  it.each([
    'backup-app', 'backup-plist', 'backup-shim',
    'replace-app', 'replace-plist', 'replace-shim',
  ] as const)('SIGTERM immediately after %s rolls back without a flag-update race', (boundary) => {
    const value = fixture();
    writeExistingInstall(value, true);
    const before = installedTargets(value);
    value.environment.RR_SIGNAL_AFTER_MV_BOUNDARY = boundary;
    const result = run(value);
    expect(result.status).toBe(143);
    expect(installedTargets(value)).toEqual(before);
    expect(existsSync(value.running)).toBe(true);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each(['restore-app', 'restore-plist', 'restore-shim'] as const)(
    'a %s failure keeps the old backup and reports recovery material instead of deleting it',
    (boundary) => {
      const value = fixture();
      writeExistingInstall(value, true);
      value.environment.RR_FAIL_FIRST_BOOTSTRAP = '1';
      value.environment.RR_FAIL_RESTORE_BOUNDARY = boundary;
      const result = run(value);
      const recovery = recoveryDirectories(value);
      expect(result.status).not.toBe(0);
      expect(existsSync(value.running)).toBe(false);
      expect(recovery.length).toBeGreaterThan(0);
      expect(recovery.some((path) => result.stderr.includes(path))).toBe(true);
      const expectedBackup = boundary === 'restore-app' ? 'old.app'
        : boundary === 'restore-plist' ? 'old.plist'
          : 'old.shim';
      expect(recovery.some((path) => existsSync(join(path, expectedBackup)))).toBe(true);
    },
  );

  it('a rollback bootstrap failure is reported and preserves recovery material', () => {
    const value = fixture();
    writeExistingInstall(value, true);
    const before = installedTargets(value);
    value.environment.RR_FAIL_FIRST_BOOTSTRAP = '1';
    value.environment.RR_FAIL_ROLLBACK_BOOTSTRAP = '1';
    const result = run(value);
    const recovery = recoveryDirectories(value);
    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(existsSync(value.running)).toBe(false);
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.some((path) => result.stderr.includes(path))).toBe(true);
  });

  it.each([
    ['codesign', (source: string) => source.replace(
      '/usr/bin/codesign --verify --deep --strict --verbose=2 "$CANDIDATE_APP"',
      '/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"',
    )],
    ['spctl', (source: string) => source.replace(
      '/usr/sbin/spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"',
      '/usr/sbin/spctl --assess --type execute --verbose=2 "$APP"',
    )],
    ['launchctl bootout label', (source: string) => source.replaceAll(
      'bootout "gui/$OWNER/$LABEL"', 'bootout "gui/$OWNER/wrong-label"',
    )],
    ['launchctl bootout domain', (source: string) => source.replaceAll(
      'bootout "gui/$OWNER/$LABEL"', 'bootout "gui/99999/$LABEL"',
    )],
  ] as const)('a mutated wrong-target %s call fails before destructive replacement', (_, mutate) => {
    const value = fixture();
    writeExistingInstall(value, true);
    const before = installedTargets(value);
    const result = run(value, '/bin/sh', mutate);
    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(events(value).some((line) => line.startsWith('mv:replace-'))).toBe(false);
  });

  it.each([
    ['plist', (source: string) => source.replaceAll(
      'bootstrap "gui/$OWNER" "$PLIST"', 'bootstrap "gui/$OWNER" "$SHIM"',
    )],
    ['domain', (source: string) => source.replaceAll(
      'bootstrap "gui/$OWNER" "$PLIST"', 'bootstrap "gui/99999" "$PLIST"',
    )],
  ] as const)('a mutated wrong-%s launchctl bootstrap fails and rolls all targets back', (_, mutate) => {
    const value = fixture();
    writeExistingInstall(value, true);
    const before = installedTargets(value);
    const result = run(value, '/bin/sh', mutate);
    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(existsSync(value.running)).toBe(false);
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
