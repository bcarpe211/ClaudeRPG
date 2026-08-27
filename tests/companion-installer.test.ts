import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installerTemplate = join(process.cwd(), 'companion/packaging/install.sh');
const iconResource = join(process.cwd(), 'companion/packaging/RuntimeRaiders.icns');
const managedAgentPlist = join(
  process.cwd(),
  'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
);
const releaseBuilder = join(process.cwd(), 'scripts/release/build-runtime-raiders-agent.sh');
const signedReleaseVerifier = join(process.cwd(), 'scripts/test/verify-runtime-raiders-signed-release.sh');
const legacyLabel = 'com.redlattice.runtime-raiders-agent';
const managedLabel = 'com.redlattice.runtime-raiders.agent';
const appBundleId = 'com.redlattice.runtime-raiders';
const version = '0.4.4';
const teamId = 'ABCDE12345';
const enrollmentCode = 'E'.repeat(43);
const token = 'T'.repeat(43);
const secret = 'a'.repeat(64);
const roots: string[] = [];

type ActivationState = 'disabled' | 'preparing' | 'ready';
type PersistedState = 'missing' | 'invalid' | 'enabled' | 'disabled';

function agentStatus(overrides: Partial<{
  enabled: boolean;
  activationState: ActivationState;
  persistedState: PersistedState;
  daemonRunning: boolean;
  installedCompanionVersion: string;
}> = {}): string {
  return JSON.stringify({
    activationState: 'disabled',
    activeRunCount: 0,
    availableCompanionVersion: null,
    compiledAdapters: {
      claude_code: 'unavailable',
      codex_cli: 'available',
      codex_desktop: 'available',
      omp: 'unavailable',
    },
    daemonRunning: true,
    enabled: false,
    installedCompanionVersion: version,
    lastSuccessfulUploadMS: null,
    persistedState: 'disabled',
    queuedEventCount: 0,
    serverEnabledSurfaces: ['codex_desktop', 'codex_cli'],
    updateCommand: null,
    ...overrides,
  });
}

function agentStatusWithout(field: 'daemonRunning' | 'installedCompanionVersion'): string {
  const value = JSON.parse(agentStatus()) as Record<string, unknown>;
  delete value[field];
  return JSON.stringify(value);
}

const nonDisabledStatuses = [
  ['enabled flag', agentStatus({ enabled: true })],
  ['preparing activation', agentStatus({ activationState: 'preparing' })],
  ['ready activation', agentStatus({ activationState: 'ready' })],
  ['enabled persisted state', agentStatus({ persistedState: 'enabled' })],
  ['invalid persisted state', agentStatus({ persistedState: 'invalid' })],
  ['malformed status', '{not-json'],
] as const;

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
  cpSync(iconResource, join(repository, 'companion/packaging/RuntimeRaiders.icns'));
  cpSync(
    managedAgentPlist,
    join(repository, 'companion/packaging/com.redlattice.runtime-raiders.agent.plist'),
  );
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
    'operation=${1:-status}',
    '[ "$operation" != __runtime-raiders-managed-agent ] || operation="$operation:${2:-}"',
    `printf 'agent:%s home=%s verify=%s support=%s response=%s argv=%s\\n' "$operation" "$HOME" "\${RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS:-unset}" "\${RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY:-unset}" "\${RUNTIME_RAIDERS_VERIFY_VERSION_RESPONSE_FILE:-unset}" "$*" >> '${agentLog}'`,
    'expected_support="$HOME/Library/Application Support"',
    '[ "${RUNTIME_RAIDERS_VERIFY_RUNTIME_INPUTS:-}" = 1 ] && [ "${RUNTIME_RAIDERS_VERIFY_APPLICATION_SUPPORT_DIRECTORY:-}" = "$expected_support" ] || { echo unsafeVerificationEnvironment >&2; exit 79; }',
    'if [ "$#" -eq 2 ] && [ "$1" = __runtime-raiders-lifecycle-lock-hold ]; then',
    '  [ "$2" = "$0" ] || exit 64',
    '  printf "locked\\n"',
    '  while IFS= read -r _lock_input; do',
    '    case "$_lock_input" in held) printf "held\\n";; release) printf "released\\n"; exit 0;; *) exit 64;; esac',
    '  done',
    '  exit 0',
    'fi',
    'managed_state="$HOME/Library/Application Support/Runtime Raiders/state/managed-service-state"',
    'managed_running="$HOME/Library/Application Support/Runtime Raiders/managed-running"',
    'case "${1:-} ${2:-}" in',
    '  "__runtime-raiders-managed-agent status") cat "$managed_state";;',
    '  "__runtime-raiders-managed-agent register")',
    '    printf "enabled\\n" > "$managed_state"; : > "$managed_running"; printf "enabled\\n";;',
    '  "__runtime-raiders-managed-agent unregister")',
    '    printf "not-registered\\n" > "$managed_state"; rm -f "$managed_running"; printf "not-registered\\n";;',
    'esac',
    'case "${1:-}" in __runtime-raiders-managed-agent) exit 0;; esac',
    'case "${1:-status}" in',
    '  status|update)',
    '    socket_path="$HOME/Library/Application Support/Runtime Raiders/agent.sock"',
    '    [ "$(printf %s "$socket_path" | /usr/bin/wc -c | /usr/bin/tr -d " ")" -lt 104 ] || { echo unsafeSocketPath >&2; exit 78; };;',
    'esac',
    'case "${1:-status}" in',
    '  status)',
    '    if [ "${2:-}" = --json ] && [ "$#" -eq 2 ]; then',
    `      printf '%s\\n' '${agentStatus({ persistedState: 'missing' }).replace(version, '0.4.0')}'`,
    '    else',
    "      printf '%s\\n' 'Runtime Raiders' 'Collection: OFF' 'Status: Off'",
    '    fi;;',
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
    '  printf "Executable=fake\\nIdentifier=com.redlattice.runtime-raiders\\nFormat=app bundle with Mach-O universal (arm64 x86_64)\\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded\\nSignature size=1\\nAuthority=Developer ID Application: Runtime Raiders (ABCDE12345)\\nTeamIdentifier=ABCDE12345\\nRuntime Version=26.0.0\\nTimestamp=Aug 18, 2026 at 12:00:00\\n" >&2',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = --verify ] && [ "${2:-}" = --strict ]; then',
    '  [ "$#" -eq 4 ] || { echo "codesign fake rejects split requirement arguments" >&2; exit 65; }',
    `  [ "$3" = '-R=identifier "com.redlattice.runtime-raiders" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"' ] || { echo "codesign fake requires inline requirement expression" >&2; exit 65; }`,
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

function replaceReleaseSummaryField(
  value: BuildFixture,
  key: string,
  replacement: string | null,
): void {
  const summaryPath = join(value.output, 'release-summary.txt');
  const summary = readFileSync(summaryPath, 'utf8');
  const line = new RegExp(`^${key}=.*\\n`, 'm');
  expect(summary).toMatch(line);
  writeFileSync(summaryPath, summary.replace(line, replacement === null ? '' : `${key}=${replacement}\n`));
}

function refreshReleaseFileSummaryEvidence(value: BuildFixture, name: string): void {
  const bytes = readFileSync(join(value.output, name));
  replaceReleaseSummaryField(value, `${name}_bytes`, String(bytes.byteLength));
  replaceReleaseSummaryField(
    value,
    `${name}_sha256`,
    createHash('sha256').update(bytes).digest('hex'),
  );
}

function mutateSignedArchive(value: BuildFixture, mutate: (application: string) => void): void {
  const extracted = join(value.root, 'signed-archive-mutation');
  mkdirSync(extracted);
  const archive = join(value.output, 'runtime-raiders-agent.zip');
  const unpacked = spawnSync('/usr/bin/ditto', ['-x', '-k', archive, extracted], { encoding: 'utf8' });
  expect(unpacked.status, unpacked.stderr).toBe(0);
  const application = join(extracted, 'Runtime Raiders.app');
  mutate(application);
  rmSync(archive);
  const repacked = spawnSync(
    '/usr/bin/ditto',
    ['-c', '-k', '--keepParent', application, archive],
    { encoding: 'utf8' },
  );
  expect(repacked.status, repacked.stderr).toBe(0);
  const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const installer = join(value.output, 'install.sh');
  writeFileSync(
    installer,
    readFileSync(installer, 'utf8').replace(
      /^ARCHIVE_SHA256='[^']*'$/m,
      `ARCHIVE_SHA256='${archiveSha256}'`,
    ),
  );
  refreshReleaseFileSummaryEvidence(value, 'install.sh');
  refreshReleaseFileSummaryEvidence(value, 'runtime-raiders-agent.zip');
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

function commitAllFixtureChanges(value: BuildFixture, message: string): void {
  for (const args of [['add', '-A'], ['commit', '-qm', message]]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: value.repository, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
}

function plist(shortVersion = version, bundleId = appBundleId, bundleVersion = shortVersion): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>CFBundleIdentifier</key><string>${bundleId}</string>`,
    '<key>CFBundleExecutable</key><string>runtime-raiders-agent</string>',
    '<key>CFBundleName</key><string>Runtime Raiders</string>',
    '<key>CFBundleDisplayName</key><string>Runtime Raiders</string>',
    '<key>CFBundleIconFile</key><string>RuntimeRaiders</string>',
    `<key>CFBundleShortVersionString</key><string>${shortVersion}</string>`,
    `<key>CFBundleVersion</key><string>${bundleVersion}</string>`,
    '</dict></plist>',
    '',
  ].join('\n');
}

function legacyLaunchAgentPlist(agent: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${legacyLabel}</string>`,
    '<key>AssociatedBundleIdentifiers</key>',
    `<array><string>${legacyLabel}</string></array>`,
    '<key>ProgramArguments</key>',
    `<array><string>${agent}</string><string>daemon</string></array>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ProcessType</key><string>Background</string>',
    '</dict></plist>',
    '',
  ].join('\n');
}

function managedAgentLines(identity: 'candidate' | 'old-managed'): string[] {
  const registerFailure = identity === 'candidate'
    ? '${RR_FAIL_NEW_MANAGED_REGISTER:-${RR_FAIL_MANAGED_REGISTER:-0}}'
    : '${RR_FAIL_OLD_MANAGED_REGISTER:-0}';
  const unregisterFailure = identity === 'candidate'
    ? '${RR_FAIL_ROLLBACK_MANAGED_UNREGISTER:-0}'
    : '${RR_FAIL_OLD_MANAGED_UNREGISTER:-${RR_FAIL_MANAGED_UNREGISTER:-0}}';
  const statusFailure = identity === 'candidate'
    ? '${RR_FAIL_STATUS:-0}'
    : '${RR_FAIL_RESTORED_STATUS:-0}';
  return [
    `printf "agent:${identity}:%s\\n" "$*" >> "$RR_EVENT_LOG"`,
    'if [ "$#" -eq 2 ] && [ "$1" = __runtime-raiders-lifecycle-lock-hold ]; then',
    '  [ "$2" = "$0" ] || exit 64',
    '  [ "${RR_FAIL_LIFECYCLE_LOCK:-0}" != 1 ] || exit 75',
    '  if [ "${RR_COMPLETE_REMOVAL_BEFORE_LOCK:-0}" = 1 ]; then',
    '    if /usr/bin/find "$RR_SUPPORT" -mindepth 1 -maxdepth 1 -name \'.runtime-raiders-install.*\' -print -quit 2>/dev/null | /usr/bin/grep . >/dev/null; then',
    '      printf "removal:prelock-work-present\\n" >> "$RR_EVENT_LOG"',
    '    fi',
    '    /bin/rm -rf "$RR_SUPPORT" "$RR_COMMAND_DIRECTORY"',
    '  fi',
    `  printf "lock:${identity}:acquired\\n" >> "$RR_EVENT_LOG"`,
    '  : > "$RR_LOCK_HELD"',
    `  trap '/bin/rm -f "$RR_LOCK_HELD"; printf "lock:${identity}:released\\n" >> "$RR_EVENT_LOG"' EXIT`,
    '  printf "locked\\n"',
    '  [ "${RR_EXIT_LIFECYCLE_LOCK_AFTER_READY:-0}" != 1 ] || exit 75',
    '  while IFS= read -r _lock_input; do',
    '    case "$_lock_input" in held) printf "held\\n";; release) printf "released\\n"; exit 0;; *) exit 64;; esac',
    '  done',
    '  exit 0',
    'fi',
    'case "${1:-} ${2:-}" in',
    '  "__runtime-raiders-managed-agent status")',
    ...(identity === 'candidate' ? [
      '    if [ -n "${RR_NEW_MANAGED_STATUS:-}" ]; then printf "%s\\n" "$RR_NEW_MANAGED_STATUS"; exit 0; fi',
    ] : []),
    '    /bin/cat "$RR_MANAGED_STATE"; exit 0;;',
    '  "__runtime-raiders-managed-agent register")',
    '    [ -e "$RR_LOCK_HELD" ] || printf "lock:missing:register\\n" >> "$RR_EVENT_LOG"',
    `    [ "${registerFailure}" != 1 ] || exit 79`,
    '    printf "enabled\\n" > "$RR_MANAGED_STATE"',
    '    : > "$RR_RUNNING"',
    ...(identity === 'candidate' ? [
      '    [ "${RR_NEW_REGISTER_MUTATE_THEN_FAIL:-0}" != 1 ] || exit 79',
      '    if [ "${RR_SIGNAL_DURING_NEW_REGISTER:-0}" = 1 ]; then kill -TERM "$PPID"; sleep 1; exit 143; fi',
    ] : []),
    '    printf "enabled\\n"; exit 0;;',
    '  "__runtime-raiders-managed-agent unregister")',
    '    [ -e "$RR_LOCK_HELD" ] || printf "lock:missing:unregister\\n" >> "$RR_EVENT_LOG"',
    `    [ "${unregisterFailure}" != 1 ] || exit 80`,
    '    printf "not-registered\\n" > "$RR_MANAGED_STATE"',
    '    /bin/rm -f "$RR_RUNNING"',
    '    : > "$RR_SERVICE_STOPPED"',
    ...(identity === 'old-managed' ? [
      '    [ "${RR_OLD_UNREGISTER_MUTATE_THEN_FAIL:-0}" != 1 ] || exit 80',
      '    if [ "${RR_SIGNAL_DURING_OLD_UNREGISTER:-0}" = 1 ]; then kill -TERM "$PPID"; sleep 1; exit 143; fi',
    ] : []),
    '    printf "not-registered\\n"; exit 0;;',
    'esac',
    ...(identity === 'candidate' ? [`[ "${statusFailure}" != 1 ] || exit 78`] : []),
    '[ "${1:-status}" = status ] || [ "${1:-}" = daemon ] || exit 64',
    'if [ "${1:-}" = status ] && [ "${2:-}" != --json ]; then',
    "  printf '%s\\n' 'Runtime Raiders' 'Collection: OFF' 'Status: Off'",
    '  exit 0',
    'fi',
    ...(identity === 'candidate' ? [
      'status_calls=0',
      'if [ -e "$RR_STATUS_CALLS" ]; then status_calls=$(/bin/cat "$RR_STATUS_CALLS"); fi',
      'status_calls=$((status_calls + 1)); printf "%s\\n" "$status_calls" > "$RR_STATUS_CALLS"',
      'if [ -n "${RR_READY_AFTER:-}" ] && [ "$status_calls" -lt "$RR_READY_AFTER" ]; then',
      '  printf "%s\\n" "$RR_NEW_COLLECTION_STATUS_BEFORE_READY"',
      'elif [ -n "${RR_NEW_COLLECTION_STATUS:-}" ]; then',
      '  printf "%s\\n" "$RR_NEW_COLLECTION_STATUS"',
      'elif [ -e "$RR_COLLECTOR_STATE" ]; then',
      '  printf "%s\\n" "$RR_DISABLED_STATUS"',
      'else',
      '  printf "%s\\n" "$RR_MISSING_STATUS"',
      'fi',
    ] : [
      'if [ -e "$RR_SERVICE_STOPPED" ]; then',
      `  [ "${statusFailure}" != 1 ] || exit 78`,
      '  printf "%s\\n" "${RR_RESTORED_COLLECTION_STATUS:-$RR_OLD_DISABLED_STATUS}"',
      'else',
      '  printf "%s\\n" "${RR_EXISTING_COLLECTION_STATUS:-$RR_OLD_DISABLED_STATUS}"',
      'fi',
    ]),
  ];
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

function recoveryJournal(value: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    operation_id: '00000000-0000-4000-8000-000000000010',
    replacement_device_id: '00000000-0000-4000-8000-000000000011',
    replacement_device_token: 'R'.repeat(43),
    companion_version: version,
    queue_disposition: 'empty',
    phase: 'replacementPrepared',
    ...value,
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
    '    printf "%s/unpacked/Runtime Raiders.app\\n" "${output%/*}" > "$RR_EXPECT_CANDIDATE"',
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
    '  printf "%s/Runtime Raiders.app\\n" "$destination" > "$RR_EXPECT_CANDIDATE"',
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
    `  expected_requirement='-R=identifier "com.redlattice.runtime-raiders" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$RR_TEAM_ID"'"'`,
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
    '  print)',
    '    [ "$#" -eq 2 ] && [ "$2" = "gui/$RR_OWNER/com.redlattice.runtime-raiders-agent" ] || exit 64',
    '    [ "${RR_FAIL_LEGACY_INSPECTION:-0}" != 1 ] || exit 75',
    '    if [ -e "$RR_SERVICE_STOPPED" ] && [ "${RR_FAIL_POST_BOOTOUT_INSPECTION:-0}" = 1 ]; then exit 75; fi',
    '    [ -e "$RR_LEGACY_JOB" ] || exit 113',
    '    printf "state = running\\n"; exit 0;;',
    '  bootout)',
    '    [ "$#" -eq 2 ] && [ "$2" = "gui/$RR_OWNER/com.redlattice.runtime-raiders-agent" ] || exit 64',
    '    [ "${RR_FAIL_LEGACY_BOOTOUT:-0}" != 1 ] || exit 75',
    '    [ -e "$RR_LEGACY_JOB" ] || exit 113',
    '    : > "$RR_SERVICE_STOPPED"',
    '    if [ "${RR_LEGACY_STILL_PRESENT_AFTER_BOOTOUT:-0}" != 1 ]; then rm -f "$RR_LEGACY_JOB" "$RR_RUNNING"; fi',
    '    if [ "${RR_SIGNAL_AFTER_OLD_STOP:-0}" = 1 ]; then kill -TERM "$PPID"; fi',
    '    exit 0;;',
    '  bootstrap)',
    '    [ "$#" -eq 3 ] && [ "$2" = "gui/$RR_OWNER" ] && [ "$3" = "$RR_LEGACY_PLIST" ] || exit 64',
    '    if [ "${RR_FAIL_ROLLBACK_BOOTSTRAP:-0}" = 1 ]; then exit 76; fi',
    '    : > "$RR_LEGACY_JOB"; : > "$RR_RUNNING"; exit 0;;',
    '  *) exit 64;;',
    'esac',
  ]);
  executable(join(bin, 'stty'), [
    'printf "tty:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    '[ "${1:-}" != -g ] || printf saved',
  ]);
  executable(join(bin, 'uuidgen'), ['printf "%s\\n" "${RR_UUID:-00000000-0000-4000-8000-000000000001}"']);
  executable(join(bin, 'sleep'), ['exit 0']);
  executable(join(bin, 'date'), [
    '[ "$#" -eq 1 ] && [ "$1" = +%s ] || exit 64',
    'date_calls=0',
    'if [ -e "$RR_DATE_CALLS" ]; then date_calls=$(/bin/cat "$RR_DATE_CALLS"); fi',
    'date_calls=$((date_calls + 1)); printf "%s\\n" "$date_calls" > "$RR_DATE_CALLS"',
    'printf "%s\\n" "$date_calls"',
  ]);
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
    '    */old.plist:"$RR_LEGACY_PLIST") boundary=restore-plist;;',
    '    */old.shim:"$RR_SHIM") boundary=restore-shim;;',
    '    *:"$RR_APP") boundary=replace-app;;',
    '    *:"$RR_SHIM") boundary=replace-shim;;',
    '    *:"$RR_COMMAND") boundary=replace-command;;',
    '  esac',
    'fi',
    'if [ -n "$boundary" ]; then',
    '  printf "mv:%s\\n" "$boundary" >> "$RR_EVENT_LOG"',
    '  [ -e "$RR_LOCK_HELD" ] || printf "lock:missing:%s\\n" "$boundary" >> "$RR_EVENT_LOG"',
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
  const app = join(support, 'Runtime Raiders.app');
  const plistPath = join(home, 'Library/LaunchAgents', `${legacyLabel}.plist`);
  const shim = join(support, 'raiders');
  const command = join(home, '.local/bin/raiders');
  const archiveTree = join(root, 'archive-tree');
  const candidate = join(archiveTree, 'Runtime Raiders.app');
  const eventLog = join(root, 'events.log');
  const argvLog = join(root, 'argv.log');
  const enrollmentStdin = join(root, 'enrollment-stdin.json');
  const running = join(root, 'running');
  const managedState = join(root, 'managed-state');
  const legacyJob = join(root, 'legacy-job');
  const statusCalls = join(root, 'status-calls');
  const dateCalls = join(root, 'date-calls');
  const archive = join(root, 'runtime-raiders-agent.zip');
  const enrollmentResponse = join(root, 'enrollment-response.json');
  const tty = join(root, 'tty');
  const history = join(root, 'immutable-history');
  const lockHeld = join(root, 'lifecycle-lock-held');
  mkdirSync(join(candidate, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(candidate, 'Contents/Resources'));
  mkdirSync(join(candidate, 'Contents/Library/LaunchAgents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(candidate, 'Contents/Info.plist'), plist());
  cpSync(iconResource, join(candidate, 'Contents/Resources/RuntimeRaiders.icns'));
  cpSync(
    managedAgentPlist,
    join(candidate, 'Contents/Library/LaunchAgents', `${managedLabel}.plist`),
  );
  executable(
    join(candidate, 'Contents/MacOS/runtime-raiders-agent'),
    managedAgentLines('candidate'),
  );
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
  writeFileSync(history, 'Raider/account/Run/score/reward/beta history stays immutable\n');
  writeFileSync(managedState, 'not-registered\n');
  const bin = fakeTools(root);
  return {
    root, home, support, state, outbox, app, plist: plistPath, shim, command,
    candidate, eventLog, argvLog, enrollmentStdin, enrollmentResponse, running, managedState,
    legacyJob, statusCalls, dateCalls, history, lockHeld,
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
      RR_MANAGED_STATE: managedState,
      RR_DISABLED_STATUS: agentStatus(),
      RR_MISSING_STATUS: agentStatus({ persistedState: 'missing' }),
      RR_OLD_DISABLED_STATUS: agentStatus({ installedCompanionVersion: '0.4.2' }),
      RR_OLD_STOPPED_STATUS: agentStatus({
        daemonRunning: false,
        installedCompanionVersion: '0.4.2',
      }),
      RR_LEGACY_JOB: legacyJob,
      RR_STATUS_CALLS: statusCalls,
      RR_DATE_CALLS: dateCalls,
      RR_COLLECTOR_STATE: join(state, 'collector-state.json'),
      RR_APP: app,
      RR_PLIST: plistPath,
      RR_LEGACY_PLIST: plistPath,
      RR_SHIM: shim,
      RR_COMMAND: command,
      RR_COMMAND_DIRECTORY: join(home, '.local/bin'),
      RR_SUPPORT: support,
      RR_OWNER: String(process.getuid!()),
      RR_SERVICE_STOPPED: join(root, 'service-stopped'),
      RR_EXPECT_CANDIDATE: join(root, 'expected-candidate'),
      RR_TEAM_ID: teamId,
      RR_TTY: tty,
      RR_FAKE_BIN: bin,
      RR_LOCK_HELD: lockHeld,
    } as NodeJS.ProcessEnv,
  };
}

function renderInstaller(value: Fixture, mutate: (source: string) => string = (source) => source): string {
  const fake = value.environment.RR_FAKE_BIN!;
  const tty = value.environment.RR_TTY!;
  const rendered = join(value.root, 'install-rendered.sh');
  const validator = join(value.root, 'old-validator');
  executable(validator, ['exit 0']);
  const archiveSha256 = createHash('sha256')
    .update(readFileSync(value.environment.RR_ARCHIVE!))
    .digest('hex');
  const source = mutate(readFileSync(installerTemplate, 'utf8'))
    .replaceAll('__RUNTIME_RAIDERS_COMPANION_VERSION__', version)
    .replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', teamId)
    .replaceAll('__RUNTIME_RAIDERS_ARCHIVE_SHA256__', archiveSha256)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SEQUENCE__', '16')
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SHA__', 'b'.repeat(40))
    .replaceAll('__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__', '2')
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__', 'c'.repeat(64))
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__', readFileSync(validator).toString('base64'))
    .replaceAll("PRIVATE_TEMP_ROOT='/private/tmp'", `PRIVATE_TEMP_ROOT='${value.root}'`)
    .replaceAll('/usr/bin/curl', join(fake, 'curl'))
    .replaceAll('/usr/bin/ditto', join(fake, 'ditto'))
    .replaceAll('/usr/bin/codesign', join(fake, 'codesign'))
    .replaceAll('/usr/sbin/spctl', join(fake, 'spctl'))
    .replaceAll('/bin/launchctl', join(fake, 'launchctl'))
    .replaceAll('/bin/sleep', join(fake, 'sleep'))
    .replaceAll('/bin/date', join(fake, 'date'))
    .replaceAll('/bin/mv', join(fake, 'mv'))
    .replaceAll('/bin/stty', join(fake, 'stty'))
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
  writeFileSync(join(value.app, 'Contents/Info.plist'), plist('0.4.2', legacyLabel));
  executable(join(value.app, 'Contents/MacOS/runtime-raiders-agent'), [
    'printf "agent:legacy:%s\\n" "$*" >> "$RR_EVENT_LOG"',
    'if [ "${1:-}" = status ] && [ "${2:-}" != --json ]; then',
    "  printf '%s\\n' 'Runtime Raiders' 'Collection: OFF' 'Status: Off'",
    '  exit 0',
    'fi',
    'if [ -e "$RR_SERVICE_STOPPED" ]; then',
    '  [ "${RR_FAIL_RESTORED_STATUS:-0}" != 1 ] || exit 78',
    '  if [ -e "$RR_LEGACY_JOB" ]; then',
    '    printf "%s\\n" "${RR_RESTORED_COLLECTION_STATUS:-$RR_OLD_DISABLED_STATUS}"',
    '  else',
    '    printf "%s\\n" "${RR_RESTORED_COLLECTION_STATUS:-$RR_OLD_STOPPED_STATUS}"',
    '  fi',
    'else',
    '  printf "%s\\n" "${RR_EXISTING_COLLECTION_STATUS:-$RR_OLD_DISABLED_STATUS}"',
    'fi',
  ]);
  writeFileSync(
    value.plist,
    legacyLaunchAgentPlist(join(value.app, 'Contents/MacOS/runtime-raiders-agent')),
    { mode: 0o600 },
  );
  executable(value.shim, [
    '# old legacy shim',
    'exec "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent" "$@"',
  ]);
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
  writeFileSync(value.legacyJob, 'registered\n');
}

function writeManagedInstall(value: Fixture): void {
  mkdirSync(join(value.app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(value.state, { recursive: true });
  mkdirSync(value.outbox, { recursive: true });
  mkdirSync(join(value.home, '.local/bin'), { recursive: true });
  writeFileSync(join(value.app, 'Contents/Info.plist'), plist('0.4.2'));
  executable(
    join(value.app, 'Contents/MacOS/runtime-raiders-agent'),
    managedAgentLines('old-managed'),
  );
  executable(value.shim, [
    '# old managed shim',
    'exec "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent" "$@"',
  ]);
  symlinkSync(value.shim, value.command);
  writeFileSync(join(value.state, 'enrollment.json'), enrollment(), { mode: 0o600 });
  writeFileSync(
    join(value.state, 'collector-state.json'),
    '{"enabled":false,"files":{"opaque":"preserve"},"version":1}\n',
    { mode: 0o600 },
  );
  writeFileSync(join(value.state, 'opaque-state.bin'), Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  writeFileSync(join(value.outbox, 'event.json'), '{"opaque":"queued"}\n', { mode: 0o600 });
  writeFileSync(value.managedState, 'enabled\n');
  writeFileSync(value.running, 'old managed daemon running\n');
}

function writePreservedUninstall(value: Fixture): void {
  writeManagedInstall(value);
  rmSync(value.app, { recursive: true });
  rmSync(value.shim);
  rmSync(value.command);
  writeFileSync(value.managedState, 'not-registered\n');
  rmSync(value.running);
}

function assertNoHistoryMutation(value: Fixture, before: string, output: string): void {
  expect(readFileSync(value.history, 'utf8')).toBe(before);
  expect(events(value)).not.toContain('history:mutate');
  expect(output).not.toMatch(/(?:move|delete|transfer).*(?:Raider|account|Run|score|reward|history)/i);
}

function expectPreservedStateFailure(value: Fixture, result: ReturnType<typeof run>): void {
  expect(result.status).not.toBe(0);
  expect(existsSync(value.app)).toBe(false);
  expect(existsSync(value.shim)).toBe(false);
  expect(existsSync(value.command)).toBe(false);
  expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
  expect(existsSync(value.running)).toBe(false);
  expect(events(value).some((line) => line.startsWith('mv:'))).toBe(false);
  expect(events(value).some((line) => line.startsWith('curl:'))).toBe(false);
  expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
  expect(events(value).some((line) => line.startsWith('agent:candidate:'))).toBe(false);
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
    command: existsSync(value.command) || lstatIfPresent(value.command)?.isSymbolicLink()
      ? `L:${readlinkSync(value.command)}`
      : null,
  };
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function recoveryDirectories(value: Fixture): string[] {
  const launchAgents = join(value.home, 'Library/LaunchAgents');
  return [
    ...readdirSync(value.root)
      .filter((name) => name.startsWith('.runtime-raiders-install.'))
      .map((name) => join(value.root, name)),
    ...(existsSync(value.support)
      ? readdirSync(value.support).filter((name) => name.startsWith('.runtime-raiders-install.')).map((name) => join(value.support, name))
      : []),
    ...(existsSync(launchAgents)
      ? readdirSync(launchAgents).filter((name) => name.startsWith('.runtime-raiders-backup.')).map((name) => join(launchAgents, name))
      : []),
  ];
}

function stagedResidue(value: Fixture): string[] {
  const commandDirectory = join(value.home, '.local/bin');
  return [
    ...(existsSync(value.support)
      ? readdirSync(value.support)
        .filter((name) => name.startsWith('.runtime-raiders-shim.'))
        .map((name) => join(value.support, name))
      : []),
    ...(existsSync(commandDirectory)
      ? readdirSync(commandDirectory)
        .filter((name) => name.startsWith('.raiders.'))
        .map((name) => join(commandDirectory, name))
      : []),
  ];
}

function writeInstallForm(value: Fixture, form: 'fresh' | 'legacy' | 'managed'): void {
  if (form === 'legacy') writeExistingInstall(value, false);
  if (form === 'managed') writeManagedInstall(value);
}

function expectRecoveryPreserved(
  value: Fixture,
  result: ReturnType<typeof run>,
): string[] {
  const recovery = recoveryDirectories(value);
  expect(recovery.length).toBeGreaterThan(0);
  expect(recovery.some((path) => result.stderr.includes(path))).toBe(true);
  expect(result.stderr).toContain('rollback was incomplete; do not retry');
  return recovery;
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
      'codesign <--verify> <--strict> <-R=identifier "com.redlattice.runtime-raiders"',
    );
  });

  it('signed verifier smoke keeps the runtime socket path within Darwin limit', () => {
    const value = buildFixture();
    const result = runBuild(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).not.toContain('unsafeSocketPath');
  });

  it('signed verifier removes its short smoke root after success', () => {
    const value = buildFixture();
    const result = runBuild(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const homes = [...readFileSync(value.agentLog, 'utf8').matchAll(/^agent:(?:status|update) home=([^ ]+)/gm)]
      .map((match) => match[1]);
    expect(new Set(homes).size).toBe(1);
    expect(homes[0]).toMatch(/^\/private\/tmp\/rrv\.[A-Za-z0-9]{6}\/home$/);
    expect(existsSync(homes[0])).toBe(false);
  });

  it('signed verifier removes its short smoke root after a later verification failure', () => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    writeFileSync(value.agentLog, '');
    const result = runSignedVerifier(value, {
      ...value.environment,
      RR_VERIFY_MUTATE_RELEASE: value.output,
      RR_VERIFY_MUTATION: 'hash',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release directory changed during signed verification');
    const homes = [...readFileSync(value.agentLog, 'utf8').matchAll(/^agent:(?:status|update) home=([^ ]+)/gm)]
      .map((match) => match[1]);
    expect(new Set(homes).size).toBe(1);
    expect(homes[0]).toMatch(/^\/private\/tmp\/rrv\.[A-Za-z0-9]{6}\/home$/);
    expect(existsSync(homes[0])).toBe(false);
  });

  it('signed verifier isolates installer and standalone status plus update in one verified support root', () => {
    const value = buildFixture();
    const result = runBuild(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);

    const invocations = readFileSync(value.agentLog, 'utf8').trim().split('\n');
    expect(invocations).toHaveLength(6);
    expect(invocations.map((line) => line.split(' ')[0])).toEqual([
      'agent:__runtime-raiders-lifecycle-lock-hold',
      'agent:__runtime-raiders-managed-agent:register',
      'agent:__runtime-raiders-managed-agent:status',
      'agent:status',
      'agent:status',
      'agent:update',
    ]);
    for (const line of invocations) {
      const matched = line.match(
        /^agent:(?:__runtime-raiders-lifecycle-lock-hold|__runtime-raiders-managed-agent:(?:register|status)|status|update) home=([^ ]+) verify=1 support=(.+) response=/,
      );
      expect(matched, line).not.toBeNull();
      expect(matched![1]).toMatch(/^\/private\/tmp\/rrv\.[A-Za-z0-9]{6}\/home$/);
      expect(matched![2]).toBe(`${matched![1]}/Library/Application Support`);
    }
    expect(invocations[0]).toContain('response=unset');
    expect(invocations[1]).toContain('response=unset');
    expect(invocations[2]).toContain('response=unset');
    expect(invocations[3]).toContain('response=unset');
    expect(invocations[4]).toContain('response=unset');
    expect(invocations[5]).not.toContain('response=unset');
    expect(invocations[3]).toContain('argv=status --json');
    expect(invocations[4]).toContain('argv=status --json');
  });

  it.each([
    ['missing', null],
    ['wrong', legacyLabel],
  ] as const)('signed verifier rejects a %s managed_agent_label summary field', (_case, replacement) => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    writeFileSync(value.agentLog, '');
    replaceReleaseSummaryField(value, 'managed_agent_label', replacement);

    const result = runSignedVerifier(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      replacement === null
        ? 'release-summary.txt is incomplete'
        : 'release-summary.txt trust facts are invalid',
    );
    expect(readFileSync(value.agentLog, 'utf8')).toBe('');
  });

  it.each([
    ['different parent bundle identifier', (application: string) => {
      const info = join(application, 'Contents/Info.plist');
      writeFileSync(
        info,
        readFileSync(info, 'utf8').replace(
          '<string>com.redlattice.runtime-raiders</string>',
          '<string>com.redlattice.runtime-raiders-agent</string>',
        ),
      );
    }, 'archive bundle identity or version is invalid'],
    ['missing embedded plist', (application: string) => {
      rmSync(join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      ));
    }, 'archive embedded managed agent metadata is invalid'],
    ['symlinked embedded plist', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      rmSync(embedded);
      symlinkSync('../../Info.plist', embedded);
    }, 'archive embedded managed agent metadata is invalid'],
    ['writable embedded plist', (application: string) => {
      chmodSync(
        join(application, 'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist'),
        0o666,
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['extra embedded plist key', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace(
          '</dict>',
          '<key>Unexpected</key><string>value</string>\n</dict>',
        ),
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['different embedded label', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace(managedLabel, legacyLabel),
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['different embedded BundleProgram', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace(
          '<string>Contents/MacOS/runtime-raiders-agent</string>',
          '<string>Contents/MacOS/other-agent</string>',
        ),
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['different embedded daemon argument', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace('<string>daemon</string>', '<string>status</string>'),
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['string-typed embedded RunAtLoad', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace(
          '<key>RunAtLoad</key><true/>',
          '<key>RunAtLoad</key><string>true</string>',
        ),
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['string-typed embedded KeepAlive', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace(
          '<key>KeepAlive</key><true/>',
          '<key>KeepAlive</key><string>true</string>',
        ),
      );
    }, 'archive embedded managed agent metadata is invalid'],
    ['retired AssociatedBundleIdentifiers key', (application: string) => {
      const embedded = join(
        application,
        'Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        embedded,
        readFileSync(embedded, 'utf8').replace(
          '</dict>',
          [
            '<key>AssociatedBundleIdentifiers</key>',
            '<array><string>com.redlattice.runtime-raiders</string></array>',
            '</dict>',
          ].join('\n'),
        ),
      );
    }, 'archive embedded managed agent metadata is invalid'],
  ] as const)('signed verifier rejects a %s', (_name, mutate, expectedError) => {
    const value = buildFixture();
    expect(runBuild(value).status).toBe(0);
    writeFileSync(value.agentLog, '');
    mutateSignedArchive(value, mutate);

    const result = runSignedVerifier(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expect(readFileSync(value.agentLog, 'utf8')).toBe('');
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

  it('release build refuses a malformed icon before invoking any build tool', () => {
    const value = buildFixture();
    writeFileSync(join(value.repository, 'companion/packaging/RuntimeRaiders.icns'), 'not an icon\n');
    for (const args of [
      ['add', 'companion/packaging/RuntimeRaiders.icns'],
      ['commit', '-qm', 'malformed icon fixture'],
    ]) {
      const result = spawnSync('/usr/bin/git', args, { cwd: value.repository, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }

    const result = runBuild(value);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('Runtime Raiders icon resource is invalid');
    expect(readFileSync(value.log, 'utf8')).toBe('');
    expect(existsSync(value.output)).toBe(false);
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
    expect(readdirSync(extracted)).toEqual(['Runtime Raiders.app']);
    const application = join(extracted, 'Runtime Raiders.app');
    const info = join(application, 'Contents/Info.plist');
    for (const [key, expected] of [
      ['CFBundleIdentifier', 'com.redlattice.runtime-raiders'],
      ['CFBundleExecutable', 'runtime-raiders-agent'],
      ['CFBundleName', 'Runtime Raiders'],
      ['CFBundleDisplayName', 'Runtime Raiders'],
      ['CFBundleIconFile', 'RuntimeRaiders'],
      ['CFBundleShortVersionString', '0.4.0'],
      ['CFBundleVersion', '0.4.0'],
    ]) {
      const checked = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info], { encoding: 'utf8' });
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout.trim()).toBe(expected);
    }
    expect(readFileSync(join(application, 'Contents/Resources/RuntimeRaiders.icns')).byteLength)
      .toBeGreaterThan(0);
    const launchAgents = join(application, 'Contents/Library/LaunchAgents');
    expect(readdirSync(launchAgents)).toEqual(['com.redlattice.runtime-raiders.agent.plist']);
    const embeddedPlist = join(launchAgents, 'com.redlattice.runtime-raiders.agent.plist');
    expect(lstatSync(embeddedPlist).isSymbolicLink()).toBe(false);
    const parsedPlist = spawnSync(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', embeddedPlist],
      { encoding: 'utf8' },
    );
    expect(parsedPlist.status, parsedPlist.stderr).toBe(0);
    expect(JSON.parse(parsedPlist.stdout)).toEqual({
      BundleProgram: 'Contents/MacOS/runtime-raiders-agent',
      KeepAlive: true,
      Label: 'com.redlattice.runtime-raiders.agent',
      ProcessType: 'Background',
      ProgramArguments: ['runtime-raiders-agent', 'daemon'],
      RunAtLoad: true,
    });
    for (const key of [
      'RuntimeRaidersReleaseSequence',
      'RuntimeRaidersReleaseSHA',
      'RuntimeRaidersUpdateProtocolVersion',
    ]) {
      const checked = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info], { encoding: 'utf8' });
      expect(checked.status).not.toBe(0);
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
    expect(summary).toContain('bundle_identifier=com.redlattice.runtime-raiders');
    expect(summary).toContain('managed_agent_label=com.redlattice.runtime-raiders.agent');
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

  it('release build rejects any installer placeholder left after the three allowed substitutions', () => {
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
    expect(result.stderr).toContain('app bundle contract is invalid');
    expect(existsSync(value.output)).toBe(false);
  });

  it.each([
    ['missing embedded plist', (value: BuildFixture) => {
      rmSync(join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      ));
    }],
    ['embedded plist symlink', (value: BuildFixture) => {
      const path = join(value.repository, 'scripts/release/build-runtime-raiders-agent.sh');
      const source = readFileSync(path, 'utf8');
      const expected = [
        '/bin/cp "$MANAGED_AGENT_PLIST" \\',
        '  "$AGENT_APP/Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist"',
      ].join('\n');
      const replacement = [
        '/bin/ln -s "$MANAGED_AGENT_PLIST" \\',
        '  "$AGENT_APP/Contents/Library/LaunchAgents/com.redlattice.runtime-raiders.agent.plist"',
      ].join('\n');
      expect(source).toContain(expected);
      writeFileSync(path, source.replace(expected, replacement));
    }],
    ['retired agent label', (value: BuildFixture) => {
      const path = join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '<string>com.redlattice.runtime-raiders.agent</string>',
          '<string>com.redlattice.runtime-raiders-agent</string>',
        ),
      );
    }],
    ['absolute BundleProgram', (value: BuildFixture) => {
      const path = join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '<string>Contents/MacOS/runtime-raiders-agent</string>',
          '<string>/Applications/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent</string>',
        ),
      );
    }],
    ['wrong daemon argument', (value: BuildFixture) => {
      const path = join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('<string>daemon</string>', '<string>status</string>'),
      );
    }],
    ['string-typed RunAtLoad Boolean', (value: BuildFixture) => {
      const path = join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '<key>RunAtLoad</key><true/>',
          '<key>RunAtLoad</key><string>true</string>',
        ),
      );
    }],
    ['string-typed KeepAlive Boolean', (value: BuildFixture) => {
      const path = join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '<key>KeepAlive</key><true/>',
          '<key>KeepAlive</key><string>true</string>',
        ),
      );
    }],
    ['AssociatedBundleIdentifiers', (value: BuildFixture) => {
      const path = join(
        value.repository,
        'companion/packaging/com.redlattice.runtime-raiders.agent.plist',
      );
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '</dict>',
          [
            '  <key>AssociatedBundleIdentifiers</key>',
            '  <array><string>com.redlattice.runtime-raiders</string></array>',
            '</dict>',
          ].join('\n'),
        ),
      );
    }],
    ['retired parent bundle ID', (value: BuildFixture) => {
      const path = join(value.repository, 'scripts/release/build-runtime-raiders-agent.sh');
      const source = readFileSync(path, 'utf8');
      const expected = '<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders</string>';
      expect(source).toContain(expected);
      writeFileSync(
        path,
        source.replace(
          expected,
          '<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-agent</string>',
        ),
      );
    }],
  ])('release build rejects %s', (_name, mutate) => {
    const value = buildFixture();
    mutate(value);
    commitAllFixtureChanges(value, `mutate ${_name}`);

    const result = runBuild(value);
    expect(result.status).not.toBe(0);
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
  it('installs the exact local archive without downloading release or enrollment bytes', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    chmodSync(value.environment.RR_ARCHIVE!, 0o600);
    value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = value.environment.RR_ARCHIVE;

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value)).not.toContain('curl:archive');
    expect(events(value)).not.toContain('curl:enroll');
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
  });

  it('rejects a different local archive before stopping the installed service', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const wrongArchive = join(value.root, 'wrong-runtime-raiders-agent.zip');
    writeFileSync(wrongArchive, 'different signed release bytes\n', { mode: 0o600 });
    value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = wrongArchive;

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('local archive does not match this installer');
    expectNoBootout(value);
    expect(events(value)).not.toContain('curl:archive');
  });

  it.each([
    ['relative path', (value: Fixture) => {
      value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = 'runtime-raiders-agent.zip';
    }],
    ['symlink', (value: Fixture) => {
      const path = join(value.root, 'archive-link.zip');
      symlinkSync(value.environment.RR_ARCHIVE!, path);
      value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = path;
    }],
    ['extra hard link', (value: Fixture) => {
      const path = join(value.root, 'archive-hard-link.zip');
      linkSync(value.environment.RR_ARCHIVE!, path);
      value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = path;
    }],
    ['group-writable mode', (value: Fixture) => {
      chmodSync(value.environment.RR_ARCHIVE!, 0o620);
      value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = value.environment.RR_ARCHIVE;
    }],
  ] as const)('rejects an unsafe local archive with %s before stopping service', (_case, arrange) => {
    const value = fixture();
    writeExistingInstall(value, false);
    arrange(value);

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Runtime Raiders local archive is unsafe.');
    expectNoBootout(value);
    expect(events(value)).not.toContain('curl:archive');
  });

  it('local install refuses enrollment network when existing enrollment is invalid', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    writeFileSync(join(value.state, 'enrollment.json'), '{}\n', { mode: 0o600 });
    chmodSync(value.environment.RR_ARCHIVE!, 0o600);
    value.environment.RUNTIME_RAIDERS_LOCAL_ARCHIVE = value.environment.RR_ARCHIVE;

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Runtime Raiders refuses an invalid existing enrollment.');
    expect(events(value)).not.toContain('curl:archive');
    expect(events(value)).not.toContain('curl:enroll');
    expectNoBootout(value);
  });

  it('corrupt preserved state cannot create missing owned directories before rejection', () => {
    const value = fixture();
    writePreservedUninstall(value);
    rmSync(value.outbox, { recursive: true });
    rmSync(join(value.home, '.local'), { recursive: true });
    writeFileSync(join(value.state, 'enrollment.json'), '{}\n', { mode: 0o600 });

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Runtime Raiders refuses an invalid existing enrollment.');
    expect(existsSync(value.outbox)).toBe(false);
    expect(existsSync(join(value.home, '.local/bin'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('curl:'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('mv:'))).toBe(false);
  });

  it('fresh install uses the managed service without creating a legacy LaunchAgent plist', () => {
    const value = fixture();

    const result = run(value);
    const log = events(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(existsSync(value.app)).toBe(true);
    expect(existsSync(value.shim)).toBe(true);
    expect(existsSync(value.plist)).toBe(false);
    expect(existsSync(join(value.home, 'Library/LaunchAgents'))).toBe(false);
    expect(log.filter((line) => line === 'agent:candidate:__runtime-raiders-managed-agent register')).toHaveLength(1);
    expect(log.indexOf('mv:replace-app')).toBeLessThan(
      log.indexOf('agent:candidate:__runtime-raiders-managed-agent register'),
    );
    expect(log.indexOf('mv:replace-shim')).toBeLessThan(
      log.indexOf('agent:candidate:__runtime-raiders-managed-agent register'),
    );
    expect(log.some((line) => line.startsWith('launchctl:bootstrap '))).toBe(false);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expect(existsSync(join(value.state, 'collector-state.json'))).toBe(false);
    expect(log).toContain('agent:candidate:status --json');
    expect(result.stdout).toBe([
      'Runtime Raiders is installed.',
      'Collection is OFF.',
      'Run `raiders status` to check the setup.',
      'Run `raiders on` when you want to join the game.',
      '',
    ].join('\n'));
  });

  it.each([
    ['a stopped daemon', agentStatus({ daemonRunning: false })],
    ['the wrong installed version', agentStatus({ installedCompanionVersion: '0.4.2' })],
    ['a missing installed version', agentStatusWithout('installedCompanionVersion')],
  ] as const)('post-register readiness rejects %s after bounded retries', (_state, wire) => {
    const value = fixture();
    value.environment.RR_NEW_COLLECTION_STATUS = wire;

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(readFileSync(value.statusCalls, 'utf8')).toBe('30\n');
    expect(installedTargets(value)).toEqual({ app: {}, plist: null, shim: null, command: null });
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(false);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it('waits through delayed managed-agent startup while keeping collection disabled', () => {
    const value = fixture();
    value.environment.RR_READY_AFTER = '7';
    value.environment.RR_NEW_COLLECTION_STATUS_BEFORE_READY = agentStatus({ daemonRunning: false });

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(value.statusCalls, 'utf8')).toBe('7\n');
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
  });

  it('reports content-free readiness fields after the bounded deadline', () => {
    const value = fixture();
    const unsafeStatus = {
      ...(JSON.parse(agentStatus({ daemonRunning: false })) as Record<string, unknown>),
      device_token: token,
      dedupe_secret: secret,
    };
    value.environment.RR_NEW_COLLECTION_STATUS = JSON.stringify(unsafeStatus);

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Runtime Raiders readiness at timeout: collection=off activation=disabled persisted=disabled daemon=stopped version=expected.',
    );
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).not.toContain(secret);
    expect(installedTargets(value)).toEqual({ app: {}, plist: null, shim: null, command: null });
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
  });

  it('legacy 0.4.2 migration replaces the retired plist with the managed service', () => {
    const value = fixture();
    writeExistingInstall(value, false);

    const result = run(value);
    const log = events(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(log).toContain(`launchctl:bootout gui/${process.getuid!()}/${legacyLabel}`);
    expect(log).toContain('mv:backup-plist');
    expect(existsSync(value.plist)).toBe(false);
    expect(readFileSync(join(value.app, 'Contents/Info.plist'), 'utf8')).toBe(plist());
    expect(log.filter((line) => line === 'agent:candidate:__runtime-raiders-managed-agent register')).toHaveLength(1);
    expect(log.indexOf(`launchctl:bootout gui/${process.getuid!()}/${legacyLabel}`)).toBeLessThan(
      log.indexOf('mv:backup-app'),
    );
    expect(log.indexOf('mv:backup-shim')).toBeLessThan(
      log.indexOf('agent:candidate:__runtime-raiders-managed-agent register'),
    );
    expect(log.some((line) => line.startsWith('launchctl:bootstrap '))).toBe(false);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expect(readFileSync(join(value.state, 'collector-state.json'), 'utf8')).toContain('"enabled":false');
  });

  it('migrates an initially unregistered legacy job without bootout or bootstrap', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    rmSync(value.legacyJob);
    rmSync(value.running);

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value).some((line) => line.startsWith('launchctl:bootout '))).toBe(false);
    expect(events(value).some((line) => line.startsWith('launchctl:bootstrap '))).toBe(false);
    expect(existsSync(value.legacyJob)).toBe(false);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
  });

  it.each([
    ['hard inspection failure', 'RR_FAIL_LEGACY_INSPECTION'],
    ['hard bootout failure', 'RR_FAIL_LEGACY_BOOTOUT'],
    ['job still present after bootout', 'RR_LEGACY_STILL_PRESENT_AFTER_BOOTOUT'],
  ] as const)('%s stops legacy migration before replacement', (_failure, seam) => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    value.environment[seam] = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(events(value).some((line) => line.startsWith('mv:backup-'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('mv:replace-'))).toBe(false);
    expect(existsSync(value.legacyJob)).toBe(true);
    expect(existsSync(value.running)).toBe(true);
  });

  it('preserves recovery when post-bootout launchd inspection cannot prove absence', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    value.environment.RR_FAIL_POST_BOOTOUT_INSPECTION = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(existsSync(value.legacyJob)).toBe(false);
    expect(existsSync(value.running)).toBe(false);
    expectRecoveryPreserved(value, result);
  });

  it('managed service reinstall unregisters the old app and registers the replacement without bootstrap', () => {
    const value = fixture();
    writeManagedInstall(value);

    const result = run(value);
    const log = events(value);
    const oldUnregister = log.indexOf('agent:old-managed:__runtime-raiders-managed-agent unregister');
    const appBackup = log.indexOf('mv:backup-app');
    const newRegister = log.indexOf('agent:candidate:__runtime-raiders-managed-agent register');

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(oldUnregister).toBeGreaterThanOrEqual(0);
    expect(appBackup).toBeGreaterThan(oldUnregister);
    expect(newRegister).toBeGreaterThan(appBackup);
    expect(newRegister).toBeGreaterThan(log.indexOf('mv:replace-shim'));
    expect(log.some((line) => line.startsWith('launchctl:bootstrap '))).toBe(false);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expect(existsSync(value.plist)).toBe(false);
    expect(readFileSync(join(value.state, 'collector-state.json'), 'utf8')).toContain('"enabled":false');
  });

  it('holds the shared lifecycle lock continuously across service and filesystem mutation', () => {
    const value = fixture();
    writeManagedInstall(value);

    const result = run(value);
    const log = events(value);
    const acquired = log.indexOf('lock:candidate:acquired');
    const firstMutation = log.indexOf('agent:old-managed:__runtime-raiders-managed-agent unregister');
    const finalProof = log.lastIndexOf('agent:candidate:status --json');
    const released = log.indexOf('lock:candidate:released');

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(acquired).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThan(acquired);
    expect(released).toBeGreaterThan(finalProof);
    expect(log.some((line) => line.startsWith('lock:missing:'))).toBe(false);
    expect(existsSync(value.lockHeld)).toBe(false);
  });

  it('fails before service or filesystem mutation when the shared lifecycle lock is busy', () => {
    const value = fixture();
    writeManagedInstall(value);
    const before = treeSnapshot(value.home);
    value.environment.RR_FAIL_LIFECYCLE_LOCK = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.home)).toEqual(before);
    expect(events(value).some((line) => line.endsWith('__runtime-raiders-managed-agent unregister'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('mv:'))).toBe(false);
    expect(existsSync(value.lockHeld)).toBe(false);
  });

  it('a busy lifecycle lock cannot create missing Runtime Raiders owned directories', () => {
    const value = fixture();
    value.environment.RR_FAIL_LIFECYCLE_LOCK = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(existsSync(value.support)).toBe(false);
    expect(existsSync(join(value.home, '.local/bin'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('mv:'))).toBe(false);
    expect(existsSync(value.lockHeld)).toBe(false);
  });

  it('complete removal before lock acquisition cannot race installer owned mutation', () => {
    const value = fixture();
    writeManagedInstall(value);
    value.environment.RR_COMPLETE_REMOVAL_BEFORE_LOCK = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(events(value)).not.toContain('removal:prelock-work-present');
    expect(existsSync(value.support)).toBe(false);
    expect(existsSync(join(value.home, '.local/bin'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('mv:'))).toBe(false);
    expect(existsSync(value.lockHeld)).toBe(false);
  });

  it('fails before service or filesystem mutation when the lock holder exits after handshake', () => {
    const value = fixture();
    writeManagedInstall(value);
    const before = treeSnapshot(value.home);
    value.environment.RR_EXIT_LIFECYCLE_LOCK_AFTER_READY = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.home)).toEqual(before);
    expect(events(value).some((line) => line.endsWith('__runtime-raiders-managed-agent unregister'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('mv:'))).toBe(false);
    expect(existsSync(value.lockHeld)).toBe(false);
  });

  it('releases the lifecycle lock helper after interrupted rollback without a background leak', () => {
    const value = fixture();
    writeManagedInstall(value);
    value.environment.RR_SIGNAL_AFTER_MV_BOUNDARY = 'replace-app';

    const result = run(value);
    const log = events(value);

    expect(result.status).not.toBe(0);
    expect(log).toContain('lock:candidate:acquired');
    expect(log).toContain('lock:candidate:released');
    expect(log.some((line) => line.startsWith('lock:missing:'))).toBe(false);
    expect(existsSync(value.lockHeld)).toBe(false);
  });

  it.each(
    (['legacy', 'managed'] as const).flatMap((form) =>
      nonDisabledStatuses.map(([state, wire]) => [form, state, wire] as const)),
  )('%s reinstall rejects %s collection status before download or service mutation', (form, _state, wire) => {
    const value = fixture();
    writeInstallForm(value, form);
    value.environment.RR_EXISTING_COLLECTION_STATUS = wire;
    const before = treeSnapshot(value.home);

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.home)).toEqual(before);
    expect(events(value).some((line) => line.startsWith('curl:'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('launchctl:'))).toBe(false);
    expect(events(value).some((line) => line.endsWith('__runtime-raiders-managed-agent unregister'))).toBe(false);
    expect(readFileSync(value.running, 'utf8')).toContain('running');
  });

  it.each(nonDisabledStatuses)(
    'post-register %s collection status rolls fresh install back to collection off',
    (_state, wire) => {
      const value = fixture();
      value.environment.RR_NEW_COLLECTION_STATUS = wire;

      const result = run(value);

      expect(result.status).not.toBe(0);
      expect(installedTargets(value)).toEqual({ app: {}, plist: null, shim: null, command: null });
      expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
      expect(existsSync(value.running)).toBe(false);
      expect(events(value)).toContain('agent:candidate:__runtime-raiders-managed-agent unregister');
      expect(recoveryDirectories(value)).toHaveLength(0);
      expect(stagedResidue(value)).toHaveLength(0);
    },
  );

  it.each(
    (['legacy', 'managed'] as const).flatMap((form) => [
      [form, 'enabled collection', agentStatus({
        enabled: true,
        activationState: 'ready',
        persistedState: 'enabled',
      })] as const,
      [form, 'invalid persisted state', agentStatus({ persistedState: 'invalid' })] as const,
      [form, 'malformed status', '{not-json'] as const,
    ]),
  )('rollback from %s preserves recovery when restored status has %s', (form, _state, wire) => {
    const value = fixture();
    writeInstallForm(value, form);
    const before = installedTargets(value);
    value.environment.RR_FAIL_STATUS = '1';
    value.environment.RR_RESTORED_COLLECTION_STATUS = wire;

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(readFileSync(value.managedState, 'utf8')).toBe(form === 'managed' ? 'enabled\n' : 'not-registered\n');
    expect(existsSync(value.running)).toBe(true);
    expectRecoveryPreserved(value, result);
  });

  it.each(
    (['legacy', 'managed'] as const).flatMap((form) => [
      [form, 'a stopped daemon', agentStatus({
        daemonRunning: false,
        installedCompanionVersion: '0.4.2',
      })] as const,
      [form, 'the wrong installed version', agentStatus({ installedCompanionVersion: version })] as const,
      [form, 'a missing installed version', agentStatusWithout('installedCompanionVersion')] as const,
    ]),
  )('rollback from %s preserves recovery when restored readiness reports %s', (form, _state, wire) => {
    const value = fixture();
    writeInstallForm(value, form);
    const before = installedTargets(value);
    value.environment.RR_FAIL_STATUS = '1';
    value.environment.RR_RESTORED_COLLECTION_STATUS = wire;

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expectRecoveryPreserved(value, result);
  });

  it('passes one exact inline designated requirement to codesign', () => {
    const value = fixture();
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(value.argvLog, 'utf8')).toContain(
      'codesign-argv <--verify> <--strict> <-R=identifier "com.redlattice.runtime-raiders"',
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

  it('fresh install uses the macOS /bin/stty path for the private code prompt', () => {
    // Catches a return to /usr/bin/stty, which does not exist on current macOS.
    const value = fixture();

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value)).toContain('tty:-g');
    expect(events(value)).toContain('tty:-echo');
    expect(events(value)).toContain('tty:saved');
  });

  it('first install explains how new and existing Raiders obtain the one-time code', () => {
    const value = fixture();

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toContain('New Raider: https://raiders.redlattice.com/register');
    expect(result.stderr).toContain('Existing Raider: https://raiders.redlattice.com/character');
    expect(result.stderr).toContain('This is not your Raider Key.');
    expect(result.stderr.indexOf('New Raider:')).toBeLessThan(
      result.stderr.indexOf('Runtime Raiders one-time enrollment code:'),
    );
  });

  it('reinstall reuses valid enrollment without asking for a code', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const result = run(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
    expect(events(value)).not.toContain('curl:enroll');
  });

  it('ordinary uninstall then reinstall restores executable artifacts while preserving disabled local state', () => {
    const value = fixture();
    writePreservedUninstall(value);
    const enrollmentBefore = readFileSync(join(value.state, 'enrollment.json'), 'utf8');
    const stateBefore = treeSnapshot(value.state);
    const outboxBefore = treeSnapshot(value.outbox);
    const historyBefore = readFileSync(value.history, 'utf8');

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).toBe(enrollmentBefore);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(treeSnapshot(value.outbox)).toEqual(outboxBefore);
    expect(existsSync(value.app)).toBe(true);
    expect(existsSync(value.shim)).toBe(true);
    expect(readlinkSync(value.command)).toBe(value.shim);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expect(events(value)).toContain('agent:candidate:status --json');
    expect(events(value)).not.toContain('agent:candidate:status');
    expect(events(value)).not.toContain('curl:enroll');
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
    expect(result.stdout).toContain('Collection is OFF.');
    assertNoHistoryMutation(value, historyBefore, `${result.stdout}${result.stderr}`);
  });

  it('complete removal then reinstall privately obtains a fresh enrollment without retaining identity', () => {
    const value = fixture();
    writeManagedInstall(value);
    const oldEnrollment = readFileSync(join(value.state, 'enrollment.json'), 'utf8');
    const historyBefore = readFileSync(value.history, 'utf8');
    rmSync(value.support, { recursive: true });
    rmSync(value.command);
    value.environment.RR_UUID = '00000000-0000-4000-8000-000000000099';
    writeFileSync(value.enrollmentResponse, JSON.stringify({
      device_token: 'N'.repeat(43),
      dedupe_secret: 'b'.repeat(64),
      server_url: 'https://raiders.redlattice.com',
      cutover_at: 1_800_000_000_001,
      enabled_surfaces: ['codex_desktop', 'codex_cli'],
    }) + '\n');

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(events(value)).toContain('curl:enroll');
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(true);
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).not.toBe(oldEnrollment);
    expect(readFileSync(join(value.state, 'enrollment.json'), 'utf8')).toContain('"device_id":"00000000-0000-4000-8000-000000000099"');
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(result.stdout).toContain('Collection is OFF.');
    assertNoHistoryMutation(value, historyBefore, `${result.stdout}${result.stderr}`);
  });

  it('interrupted re-enrollment reinstall preserves the valid journal and directs recovery without prompting', () => {
    const value = fixture();
    writePreservedUninstall(value);
    const journalPath = join(value.state, 're-enrollment.json');
    const journalBefore = recoveryJournal();
    const replacementToken = JSON.parse(journalBefore).replacement_device_token as string;
    writeFileSync(journalPath, journalBefore, { mode: 0o600 });
    const stateBefore = treeSnapshot(value.state);
    const outboxBefore = treeSnapshot(value.outbox);
    const historyBefore = readFileSync(value.history, 'utf8');
    value.environment.RR_DISABLED_STATUS = agentStatus({ daemonRunning: false });

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(treeSnapshot(value.outbox)).toEqual(outboxBefore);
    expect(existsSync(value.app)).toBe(true);
    expect(existsSync(value.shim)).toBe(true);
    expect(readlinkSync(value.command)).toBe(value.shim);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(false);
    expect(events(value)).toContain('agent:candidate:status --json');
    expect(events(value).some((line) => line.startsWith('agent:candidate:__runtime-raiders-managed-agent'))).toBe(false);
    expect(events(value)).not.toContain('curl:enroll');
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
    expect(result.stdout).toContain('Run `raiders re-enroll` to resume recovery.');
    expect(result.stdout).toContain('Collection is OFF.');
    expect(result.stdout).not.toContain('Run `raiders on` when you want to join the game.');
    for (const output of [
      result.stdout,
      result.stderr,
      readFileSync(value.argvLog, 'utf8'),
      readFileSync(value.eventLog, 'utf8'),
    ]) expect(output).not.toContain(replacementToken);
    assertNoHistoryMutation(value, historyBefore, `${result.stdout}${result.stderr}`);
  });

  it('installed but unregistered recovery companion is reinstalled without registration or start', () => {
    const value = fixture();
    writeManagedInstall(value);
    const journalPath = join(value.state, 're-enrollment.json');
    const journalBefore = recoveryJournal();
    writeFileSync(journalPath, journalBefore, { mode: 0o600 });
    writeFileSync(value.managedState, 'not-registered\n');
    rmSync(value.running);
    value.environment.RR_EXISTING_COLLECTION_STATUS = agentStatus({
      daemonRunning: false,
      installedCompanionVersion: '0.4.2',
    });
    value.environment.RR_DISABLED_STATUS = agentStatus({ daemonRunning: false });
    const stateBefore = treeSnapshot(value.state);
    const outboxBefore = treeSnapshot(value.outbox);

    const result = run(value);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(treeSnapshot(value.outbox)).toEqual(outboxBefore);
    expect(readFileSync(journalPath, 'utf8')).toBe(journalBefore);
    expect(existsSync(value.app)).toBe(true);
    expect(existsSync(value.shim)).toBe(true);
    expect(readlinkSync(value.command)).toBe(value.shim);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(false);
    expect(events(value)).not.toContain('agent:candidate:__runtime-raiders-managed-agent register');
    expect(events(value)).not.toContain('agent:old-managed:__runtime-raiders-managed-agent unregister');
    expect(events(value)).not.toContain('curl:enroll');
    expect(result.stdout).toContain('Run `raiders re-enroll` to resume recovery.');
  });

  it.each([
    'version',
    'operation_id',
    'replacement_device_id',
    'replacement_device_token',
    'companion_version',
    'queue_disposition',
    'phase',
  ] as const)('missing required recovery journal key %s fails closed before installation', (key) => {
    const value = fixture();
    writePreservedUninstall(value);
    const journal = JSON.parse(recoveryJournal()) as Record<string, unknown>;
    delete journal[key];
    writeFileSync(join(value.state, 're-enrollment.json'), JSON.stringify(journal) + '\n', { mode: 0o600 });

    const result = run(value);

    expectPreservedStateFailure(value, result);
  });

  it.each([
    ['version', '1'],
    ['operation_id', 1],
    ['replacement_device_id', 1],
    ['replacement_device_token', 1],
    ['companion_version', 1],
    ['queue_disposition', 1],
    ['phase', 1],
  ] as const)('wrong required recovery journal type for %s fails closed before installation', (key, replacement) => {
    const value = fixture();
    writePreservedUninstall(value);
    const journal = JSON.parse(recoveryJournal()) as Record<string, unknown>;
    journal[key] = replacement;
    writeFileSync(join(value.state, 're-enrollment.json'), JSON.stringify(journal) + '\n', { mode: 0o600 });

    const result = run(value);

    expectPreservedStateFailure(value, result);
  });

  it.each([
    ['version', 2],
    ['operation_id', 'not-a-uuid'],
    ['replacement_device_id', 'not-a-uuid'],
    ['replacement_device_token', 'R'.repeat(42)],
    ['companion_version', 'V'.repeat(101)],
    ['queue_disposition', 'transferred'],
    ['phase', 'unknown'],
  ] as const)('invalid required recovery journal value for %s fails closed before installation', (key, replacement) => {
    const value = fixture();
    writePreservedUninstall(value);
    const journal = JSON.parse(recoveryJournal()) as Record<string, unknown>;
    journal[key] = replacement;
    writeFileSync(join(value.state, 're-enrollment.json'), JSON.stringify(journal) + '\n', { mode: 0o600 });

    const result = run(value);

    expectPreservedStateFailure(value, result);
  });

  it.each([
    ['mode is not owner-only', (value: Fixture) => {
      chmodSync(join(value.state, 're-enrollment.json'), 0o644);
    }],
    ['hard-linked recovery journal', (value: Fixture) => {
      linkSync(join(value.state, 're-enrollment.json'), join(value.state, 're-enrollment-copy.json'));
    }],
  ] as const)('unsafe recovery journal metadata (%s) fails closed before installation', (_case, mutate) => {
    const value = fixture();
    writePreservedUninstall(value);
    writeFileSync(join(value.state, 're-enrollment.json'), recoveryJournal(), { mode: 0o600 });
    mutate(value);

    const result = run(value);

    expectPreservedStateFailure(value, result);
  });

  it.each([
    ['hard-linked enrollment', (value: Fixture) => {
      linkSync(join(value.state, 'enrollment.json'), join(value.state, 'enrollment-copy.json'));
    }],
    ['hard-linked recovery journal', (value: Fixture) => {
      writeFileSync(join(value.state, 're-enrollment.json'), recoveryJournal(), { mode: 0o600 });
      linkSync(join(value.state, 're-enrollment.json'), join(value.state, 're-enrollment-copy.json'));
    }],
  ] as const)('%s is rejected without destructive, install, network, registration, or start side effects', (_case, mutate) => {
    const value = fixture();
    writePreservedUninstall(value);
    mutate(value);

    const result = run(value);

    expectPreservedStateFailure(value, result);
  });

  it.each([
    ['corrupt recovery journal', (value: Fixture) => {
      writeFileSync(join(value.state, 're-enrollment.json'), '{"version":2}\n', { mode: 0o600 });
    }],
    ['corrupt enrollment', (value: Fixture) => {
      writeFileSync(join(value.state, 'enrollment.json'), '{"version":2}\n', { mode: 0o600 });
    }],
  ] as const)('%s after removal fails closed without replacing preserved local state', (_case, corrupt) => {
    const value = fixture();
    writePreservedUninstall(value);
    corrupt(value);
    const stateBefore = treeSnapshot(value.state);
    const outboxBefore = treeSnapshot(value.outbox);
    const historyBefore = readFileSync(value.history, 'utf8');

    const result = run(value);

    expectPreservedStateFailure(value, result);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(treeSnapshot(value.outbox)).toEqual(outboxBefore);
    assertNoHistoryMutation(value, historyBefore, `${result.stdout}${result.stderr}`);
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
  ] as const)('invalid existing enrollment (%s) fails closed without replacing it', (_, mutate) => {
    const value = fixture();
    writeExistingInstall(value, false);
    const malformed = enrollmentObject();
    mutate(malformed);
    writeFileSync(join(value.state, 'enrollment.json'), enrollment(malformed), { mode: 0o600 });
    const before = treeSnapshot(value.home);
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.home)).toEqual(before);
    expect(events(value)).not.toContain('curl:enroll');
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
    expect(events(value)).not.toContain('agent:candidate:__runtime-raiders-managed-agent register');
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
  ] as const)('%s existing enrollment fails closed without prompting', (_, writeMalformed) => {
    const value = fixture();
    writeExistingInstall(value, false);
    writeMalformed(join(value.state, 'enrollment.json'));
    const before = treeSnapshot(value.home);
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.home)).toEqual(before);
    expect(events(value)).not.toContain('curl:enroll');
    expect(events(value).some((line) => line.startsWith('tty:'))).toBe(false);
    expect(events(value)).not.toContain('agent:candidate:__runtime-raiders-managed-agent register');
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

  it.each(['legacy', 'managed'] as const)('%s reinstall preserves disabled state and outbox byte-for-byte', (form) => {
    const value = fixture();
    if (form === 'legacy') writeExistingInstall(value, false);
    else writeManagedInstall(value);
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
    writeExistingInstall(value, false);
    const result = run(value);
    const log = events(value);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(log.indexOf('codesign:deep')).toBeLessThan(log.indexOf('codesign:requirement'));
    expect(log.indexOf('codesign:requirement')).toBeLessThan(log.indexOf('spctl:assess'));
    expect(log.indexOf('spctl:assess')).toBeLessThan(log.findIndex((line) => line.startsWith('launchctl:bootout ')));
  });

  it('fails clearly and without mutation when the disposable 0.4.0 app path remains', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    renameSync(value.app, join(value.support, 'Runtime Raiders Agent.app'));
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('obsolete Runtime Raiders Agent.app canary must be removed');
    expectNoBootout(value);
    expect(events(value).some((line) => line.startsWith('curl:'))).toBe(false);
  });

  it.each([
    ['app only', (value: Fixture) => {
      writeExistingInstall(value, false);
      rmSync(value.plist);
      rmSync(value.shim);
    }],
    ['legacy app and shim without plist', (value: Fixture) => {
      writeExistingInstall(value, false);
      rmSync(value.plist);
    }],
    ['legacy plist only', (value: Fixture) => {
      writeExistingInstall(value, false);
      rmSync(value.app, { recursive: true });
      rmSync(value.shim);
    }],
    ['wrong legacy version', (value: Fixture) => {
      writeExistingInstall(value, false);
      writeFileSync(join(value.app, 'Contents/Info.plist'), plist('0.4.1', legacyLabel));
    }],
    ['new parent ID mixed with legacy plist', (value: Fixture) => {
      writeExistingInstall(value, false);
      writeFileSync(join(value.app, 'Contents/Info.plist'), plist('0.4.2'));
    }],
    ['corrupt legacy plist', (value: Fixture) => {
      writeExistingInstall(value, false);
      writeFileSync(value.plist, 'not a plist\n');
    }],
    ['managed requires approval', (value: Fixture) => {
      writeManagedInstall(value);
      writeFileSync(value.managedState, 'requires-approval\n');
    }],
    ['managed registration not found', (value: Fixture) => {
      writeManagedInstall(value);
      writeFileSync(value.managedState, 'not-found\n');
    }],
  ] as const)('%s layout fails before download or service mutation', (_, arrange) => {
    const value = fixture();
    arrange(value);
    const before = treeSnapshot(value.home);

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(treeSnapshot(value.home)).toEqual(before);
    expect(events(value).some((line) => line.startsWith('curl:'))).toBe(false);
    expect(events(value).some((line) => line.startsWith('launchctl:'))).toBe(false);
    expect(events(value).some((line) => line.endsWith('__runtime-raiders-managed-agent unregister'))).toBe(false);
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
    ['wrong bundle version', (value: Fixture) => {
      writeFileSync(join(value.candidate, 'Contents/Info.plist'), plist(version, appBundleId, '9.9.9'));
    }],
    ['malformed icon resource', (value: Fixture) => {
      writeFileSync(join(value.candidate, 'Contents/Resources/RuntimeRaiders.icns'), 'not an icns file\n');
    }],
    ['missing executable', (value: Fixture) => {
      rmSync(join(value.candidate, 'Contents/MacOS/runtime-raiders-agent'));
    }],
    ['missing embedded managed plist', (value: Fixture) => {
      rmSync(join(value.candidate, 'Contents/Library/LaunchAgents', `${managedLabel}.plist`));
    }],
    ['symlinked embedded managed plist', (value: Fixture) => {
      const path = join(value.candidate, 'Contents/Library/LaunchAgents', `${managedLabel}.plist`);
      rmSync(path);
      symlinkSync(managedAgentPlist, path);
    }],
    ['wrong embedded managed label', (value: Fixture) => {
      const path = join(value.candidate, 'Contents/Library/LaunchAgents', `${managedLabel}.plist`);
      writeFileSync(path, readFileSync(path, 'utf8').replace(managedLabel, 'example.invalid'));
    }],
    ['extra embedded managed key', (value: Fixture) => {
      const path = join(value.candidate, 'Contents/Library/LaunchAgents', `${managedLabel}.plist`);
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        '</dict>',
        '<key>AssociatedBundleIdentifiers</key><array><string>example.invalid</string></array></dict>',
      ));
    }],
    ['wrong embedded BundleProgram', (value: Fixture) => {
      const path = join(value.candidate, 'Contents/Library/LaunchAgents', `${managedLabel}.plist`);
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        'Contents/MacOS/runtime-raiders-agent',
        '/tmp/runtime-raiders-agent',
      ));
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

  it('old managed unregister failure leaves the enabled install untouched', () => {
    const value = fixture();
    writeManagedInstall(value);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_OLD_MANAGED_UNREGISTER = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expect(events(value)).not.toContain('mv:backup-app');
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each([
    ['mutates then errors', 'RR_OLD_UNREGISTER_MUTATE_THEN_FAIL', undefined],
    ['receives TERM after mutation', 'RR_SIGNAL_DURING_OLD_UNREGISTER', 143],
  ] as const)('old managed unregister %s is compensated by idempotent re-register', (_seam, variable, status) => {
    const value = fixture();
    writeManagedInstall(value);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment[variable] = '1';

    const result = run(value);

    if (status === undefined) expect(result.status).not.toBe(0);
    else expect(result.status).toBe(status);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expect(events(value)).toContain('agent:old-managed:__runtime-raiders-managed-agent register');
    expect(events(value)).not.toContain('agent:candidate:__runtime-raiders-managed-agent register');
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each([
    'backup-app', 'backup-plist', 'backup-shim', 'replace-app', 'replace-shim',
  ] as const)('%s failure restores the exact legacy registration form with collection off', (boundary) => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    const outboxBefore = treeSnapshot(value.outbox);
    value.environment.RR_FAIL_MV_BOUNDARY = boundary;

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(treeSnapshot(value.outbox)).toEqual(outboxBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(true);
    expect(events(value).filter((line) => line.startsWith('launchctl:bootstrap '))).toHaveLength(1);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it('new managed register failure restores the exact legacy install', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_NEW_MANAGED_REGISTER = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(true);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it('rollback keeps an initially unregistered legacy job absent and accepts its stopped daemon', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    rmSync(value.legacyJob);
    rmSync(value.running);
    const before = installedTargets(value);
    value.environment.RR_FAIL_STATUS = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(events(value).some((line) => line.startsWith('launchctl:bootout '))).toBe(false);
    expect(events(value).some((line) => line.startsWith('launchctl:bootstrap '))).toBe(false);
    expect(existsSync(value.legacyJob)).toBe(false);
    expect(existsSync(value.running)).toBe(false);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each(
    (['fresh', 'legacy', 'managed'] as const).flatMap((form) => [
      [form, 'mutates then errors', 'RR_NEW_REGISTER_MUTATE_THEN_FAIL', undefined] as const,
      [form, 'receives TERM after mutation', 'RR_SIGNAL_DURING_NEW_REGISTER', 143] as const,
    ]),
  )('new managed register on %s %s and is always compensated', (form, _seam, variable, status) => {
    const value = fixture();
    writeInstallForm(value, form);
    const before = installedTargets(value);
    value.environment[variable] = '1';

    const result = run(value);

    if (status === undefined) expect(result.status).not.toBe(0);
    else expect(result.status).toBe(status);
    expect(installedTargets(value)).toEqual(before);
    expect(events(value)).toContain('agent:candidate:__runtime-raiders-managed-agent unregister');
    expect(readFileSync(value.managedState, 'utf8')).toBe(form === 'managed' ? 'enabled\n' : 'not-registered\n');
    expect(existsSync(value.running)).toBe(form !== 'fresh');
    if (form === 'managed') {
      expect(events(value)).toContain('agent:old-managed:__runtime-raiders-managed-agent register');
    }
    expect(recoveryDirectories(value)).toHaveLength(0);
    expect(stagedResidue(value)).toHaveLength(0);
  });

  it.each(['requires-approval', 'not-found'] as const)(
    'new managed status %s rolls back to the exact legacy install',
    (managedStatus) => {
      const value = fixture();
      writeExistingInstall(value, false);
      const before = installedTargets(value);
      const stateBefore = treeSnapshot(value.state);
      value.environment.RR_NEW_MANAGED_STATUS = managedStatus;

      const result = run(value);

      expect(result.status).not.toBe(0);
      expect(installedTargets(value)).toEqual(before);
      expect(treeSnapshot(value.state)).toEqual(stateBefore);
      expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
      expect(existsSync(value.running)).toBe(true);
      expect(recoveryDirectories(value)).toHaveLength(0);
    },
  );

  it('post-register raiders status failure restores legacy bytes and disabled collection', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_STATUS = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(true);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it('TERM after the old service stops restores legacy bytes and exits 143', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_SIGNAL_AFTER_OLD_STOP = '1';

    const result = run(value);

    expect(result.status).toBe(143);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(true);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each([
    'backup-app', 'backup-plist', 'backup-shim', 'replace-app', 'replace-shim',
  ] as const)('TERM immediately after %s restores the exact legacy install', (boundary) => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_SIGNAL_AFTER_MV_BOUNDARY = boundary;

    const result = run(value);

    expect(result.status).toBe(143);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(true);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each([
    ['staged shim creation', '/bin/chmod 700 "$STAGED_SHIM"'],
    ['staged command creation', '/bin/ln -s "$SHIM" "$STAGED_COMMAND"'],
  ] as const)('TERM immediately after %s leaves no staged path outside recovery', (_seam, anchor) => {
    const value = fixture();

    const result = run(value, '/bin/sh', (source) =>
      source.replace(anchor, () => `${anchor}\nkill -TERM $$`));

    expect(result.status, result.stderr + result.stdout).toBe(143);
    expect(installedTargets(value)).toEqual({ app: {}, plist: null, shim: null, command: null });
    expect(stagedResidue(value)).toHaveLength(0);
    expect(recoveryDirectories(value)).toHaveLength(0);
  });

  it.each(['replace-shim', 'replace-command'] as const)(
    '%s failure leaves no staged path outside recovery',
    (boundary) => {
      const value = fixture();
      value.environment.RR_FAIL_MV_BOUNDARY = boundary;

      const result = run(value);

      expect(result.status).not.toBe(0);
      expect(installedTargets(value)).toEqual({ app: {}, plist: null, shim: null, command: null });
      expect(stagedResidue(value)).toHaveLength(0);
      expect(recoveryDirectories(value)).toHaveLength(0);
    },
  );

  it('rollback new managed unregister failure restores old managed bytes and preserves recovery', () => {
    const value = fixture();
    writeManagedInstall(value);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_STATUS = '1';
    value.environment.RR_FAIL_ROLLBACK_MANAGED_UNREGISTER = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expectRecoveryPreserved(value, result);
  });

  it.each(['restore-app', 'restore-plist', 'restore-shim'] as const)(
    'rollback %s failure preserves the exact missing backup and recovery material',
    (boundary) => {
      const value = fixture();
      writeExistingInstall(value, false);
      const before = installedTargets(value);
      const stateBefore = treeSnapshot(value.state);
      value.environment.RR_FAIL_STATUS = '1';
      value.environment.RR_FAIL_RESTORE_BOUNDARY = boundary;

      const result = run(value);
      const recovery = expectRecoveryPreserved(value, result);
      const work = recovery.find((path) => existsSync(join(path, 'old.app')) ||
        existsSync(join(path, 'old.plist')) || existsSync(join(path, 'old.shim')))!;
      const after = installedTargets(value);

      expect(result.status).not.toBe(0);
      expect(treeSnapshot(value.state)).toEqual(stateBefore);
      expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
      expect(existsSync(value.running)).toBe(boundary === 'restore-shim');
      if (boundary === 'restore-app') {
        expect(after.app).toEqual({});
        expect(after.plist).toEqual(before.plist);
        expect(after.shim).toEqual(before.shim);
        expect(treeSnapshot(join(work, 'old.app'))).toEqual(before.app);
      } else if (boundary === 'restore-plist') {
        expect(after.app).toEqual(before.app);
        expect(after.plist).toBe(null);
        expect(after.shim).toEqual(before.shim);
        expect(readFileSync(join(work, 'old.plist')).toString('base64')).toBe(before.plist);
      } else {
        expect(after.app).toEqual(before.app);
        expect(after.plist).toEqual(before.plist);
        expect(after.shim).toBe(null);
        expect(readFileSync(join(work, 'old.shim')).toString('base64')).toBe(before.shim);
      }
    },
  );

  it('rollback legacy bootstrap failure restores exact bytes and preserves recovery material', () => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_STATUS = '1';
    value.environment.RR_FAIL_ROLLBACK_BOOTSTRAP = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(false);
    expectRecoveryPreserved(value, result);
  });

  it('rollback old managed re-register failure restores bytes but preserves recovery unregistered', () => {
    const value = fixture();
    writeManagedInstall(value);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_STATUS = '1';
    value.environment.RR_FAIL_OLD_MANAGED_REGISTER = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('not-registered\n');
    expect(existsSync(value.running)).toBe(false);
    expectRecoveryPreserved(value, result);
  });

  it('rollback restored raiders status failure restores enabled managed form and preserves recovery', () => {
    const value = fixture();
    writeManagedInstall(value);
    const before = installedTargets(value);
    const stateBefore = treeSnapshot(value.state);
    value.environment.RR_FAIL_STATUS = '1';
    value.environment.RR_FAIL_RESTORED_STATUS = '1';

    const result = run(value);

    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(treeSnapshot(value.state)).toEqual(stateBefore);
    expect(readFileSync(value.managedState, 'utf8')).toBe('enabled\n');
    expect(existsSync(value.running)).toBe(true);
    expectRecoveryPreserved(value, result);
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
  ] as const)('a mutated wrong-target %s call fails before destructive replacement', (_, mutate) => {
    const value = fixture();
    writeExistingInstall(value, false);
    const before = installedTargets(value);
    const result = run(value, '/bin/sh', mutate);
    expect(result.status).not.toBe(0);
    expect(installedTargets(value)).toEqual(before);
    expect(events(value).some((line) => line.startsWith('mv:replace-'))).toBe(false);
  });

  it('the canonical command executes the flat stable app executable', () => {
    const value = fixture();
    const installed = run(value);
    expect(installed.status, installed.stderr + installed.stdout).toBe(0);
    const invoked = spawnSync(value.command, ['status'], { env: value.environment, encoding: 'utf8' });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stdout).toBe('Runtime Raiders\nCollection: OFF\nStatus: Off\n');
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
    writeExistingInstall(value, false);
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
