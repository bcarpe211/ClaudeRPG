import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = join(process.cwd(), 'companion/packaging/install.sh');
const sequenceEightMigrator = join(
  process.cwd(),
  'companion/legacy-sequence8/migrate.sh',
);
const build = join(process.cwd(), 'scripts/release/build-runtime-raiders-agent.sh');
const installerRenderer = join(process.cwd(), 'scripts/release/render-runtime-raiders-installer.sh');
const releaseValidatorBuilder = join(process.cwd(), 'scripts/release/build-runtime-raiders-release-validator.sh');
const machoUUIDSource = join(process.cwd(), 'scripts/release/runtime-raiders-macho-uuid.c');
const lifecycleGate = join(process.cwd(), 'scripts/test/runtime-raiders-lifecycle.sh');
const signedReleaseGate = join(process.cwd(), 'scripts/test/verify-runtime-raiders-signed-release.sh');
const signedReleasePaths = join(process.cwd(), 'scripts/test/runtime-raiders-gate2-paths.sh');
const validatorReproducibility = join(
  process.cwd(),
  'scripts/test/runtime-raiders-validator-reproducibility.sh',
);
const releaseRunbook = join(process.cwd(), 'docs/runtime-raiders-companion-release-gates.md');
const artifactContract = join(process.cwd(), 'config/runtime-raiders-artifact-contract.json');
const artifactContractTool = join(process.cwd(), 'scripts/lib/runtime-raiders-artifact-contract.mjs');
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
const packagedUpdateProtocolVersion = '2';
const migrationCompanionVersion = '0.3.0';
const migrationReleaseSequence = '9';
const migrationUpdateProtocolVersion = '2';
const legacyReleaseSHA = 'dec88d4f6ff600f2be92bed3b12dcfce85f84a51';

function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', 'set -eu', ...lines, ''].join('\n'));
  chmodSync(path, 0o755);
}

function fakeReleaseSwift(fake: string, log = false): void {
  executable(join(fake, 'node'), [`exec '${process.execPath}' "$@"`]);
  executable(join(fake, 'strip'), ['exit 0']);
  executable(join(fake, 'validator-codesign'), ['exit 0']);
  executable(join(fake, 'clang'), [
    'output=""',
    'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then output="$2"; shift 2; else shift; fi; done',
    '[ -n "$output" ] || exit 64',
    'printf "#!/bin/sh\\nexit 0\\n" > "$output"',
    'chmod 755 "$output"',
  ]);
  executable(join(fake, 'swift'), [
    'arch=""; scratch=""; product=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --arch) arch="$2"; shift 2;; --scratch-path) scratch="$2"; shift 2;; --product) product="$2"; shift 2;; *) shift;; esac; done',
    '[ -n "$scratch" ] || scratch="$PWD/.build"',
    'output="$scratch/$arch-apple-macosx/release"; mkdir -p "$output"',
    '[ -z "${RUNTIME_RAIDERS_TEST_SWIFT_SCRATCH_LOG:-}" ] || printf "%s\\n" "$scratch" >> "$RUNTIME_RAIDERS_TEST_SWIFT_SCRATCH_LOG"',
    'if [ -n "${RUNTIME_RAIDERS_TEST_SWIFT_READY:-}" ]; then',
    '  printf "ready\\n" > "$RUNTIME_RAIDERS_TEST_SWIFT_READY"',
    "  trap 'exit 143' HUP INT TERM",
    '  while :; do /bin/sleep 1; done',
    'fi',
    'if [ "$product" = runtime-raiders-release-validator ]; then',
    '  if [ -n "${RUNTIME_RAIDERS_TEST_RELEASE_VALIDATOR:-}" ]; then',
    '    cp "$RUNTIME_RAIDERS_TEST_RELEASE_VALIDATOR" "$output/runtime-raiders-release-validator"',
    '  else',
    '    printf "#!/bin/sh\\nexit 0\\n" > "$output/runtime-raiders-release-validator"',
    '    chmod 755 "$output/runtime-raiders-release-validator"',
    '  fi',
    'elif [ "$product" = raiders ]; then',
    '  printf "%s" "$arch" > "$output/raiders"',
    'elif [ "$product" = runtime-raiders-launcher ]; then',
    '  printf "%s" "$arch" > "$output/runtime-raiders-launcher"',
    'else',
    '  exit 64',
    'fi',
    ...(log ? ['printf "swift %s %s\\n" "$arch" "$product" >> "$RUNTIME_RAIDERS_TEST_LOG"'] : []),
  ]);
}

function fakeReleaseLipo(fake: string, log = false): void {
  executable(join(fake, 'lipo'), [
    'if [ "$1" = -create ]; then',
    '  [ "$#" -eq 5 ] && [ "$4" = -output ] || exit 64',
    '  output_directory=${5%/*}',
    '  validator=0',
    '  case "${5##*/}" in',
    '    runtime-raiders-agent)',
    '      [ "$2" = "$output_directory/raiders-arm64" ] && [ "$3" = "$output_directory/raiders-x86_64" ] || exit 70',
    '      ;;',
    '    runtime-raiders-launcher)',
    '      [ "$2" = "$output_directory/runtime-raiders-launcher-arm64" ] && [ "$3" = "$output_directory/runtime-raiders-launcher-x86_64" ] || exit 71',
      '      ;;',
    '    runtime-raiders-release-validator)',
    '      [ "$2" = "$output_directory/runtime-raiders-release-validator-arm64" ] && [ "$3" = "$output_directory/runtime-raiders-release-validator-x86_64" ] || exit 73',
    '      cp "$2" "$5"; chmod 755 "$5"; validator=1;;',
    '    *) exit 72;;',
    '  esac',
    '  if [ "$validator" -eq 0 ]; then [ "$(cat "$2")" = arm64 ] && [ "$(cat "$3")" = x86_64 ] || exit 65; printf "arm64,x86_64" > "$5"; fi',
    'elif [ "${2:-}" = -verify_arch ]; then',
    '  [ "$#" -eq 4 ] && [ "$3" = arm64 ] && [ "$4" = x86_64 ] || exit 66',
    '  case "${1##*/}" in runtime-raiders-release-validator) [ -x "$1" ];; *) [ "$(cat "$1")" = arm64,x86_64 ];; esac || exit 67',
    '  [ "${FAKE_LIPO_VERIFY_FAIL_TARGET:-}" != "${1##*/}" ] || exit 68',
    'else',
    '  exit 69',
    'fi',
    ...(log ? ['printf "lipo %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"'] : []),
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

function renderedProtocolTwoInstaller(root: string, template = installer): string {
  const legacyFixture = join(
    root,
    'home/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app',
  );
  const selectedTemplate = template === installer && existsSync(legacyFixture)
    ? sequenceEightMigrator
    : template;
  const path = join(root, 'install-protocol-two.sh');
  const validator = join(root, 'embedded-installer-validator');
  executable(validator, [
    'printf "installer-validator %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    'if [ "$#" -eq 1 ]; then phase=archive; elif [ "$#" -eq 7 ]; then phase=extracted; else exit 64; fi',
    '[ "${FAKE_INSTALLER_VALIDATOR_FAIL:-}" != "$phase" ] || exit 79',
  ]);
  const validatorBytes = readFileSync(validator);
  const validatorSHA = createHash('sha256').update(validatorBytes).digest('hex');
  writeFileSync(path, readFileSync(selectedTemplate, 'utf8')
    .replace(
      'set -eu\n',
      () => 'set -eu\nRUNTIME_RAIDERS_TEST_INSTALLER_PID=$$\nexport RUNTIME_RAIDERS_TEST_INSTALLER_PID\n',
    )
    .replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', teamId)
    .replaceAll('__RUNTIME_RAIDERS_COMPANION_VERSION__', migrationCompanionVersion)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SEQUENCE__', migrationReleaseSequence)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SHA__', releaseSHA)
    .replaceAll('__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__', migrationUpdateProtocolVersion)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__', validatorSHA)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__', validatorBytes.toString('base64'))
    .replace(
      'failure_checkpoint() { :; }',
      'failure_checkpoint() { if [ "${RUNTIME_RAIDERS_TEST_CHANGE_PATH_AFTER_PREFLIGHT:-}" = "$1" ]; then PATH="$RUNTIME_RAIDERS_TEST_CHANGED_PATH"; export PATH; fi; [ "${RUNTIME_RAIDERS_TEST_FAIL_AFTER:-}" != "$1" ] || { echo "injected failure after $1" >&2; return 91; }; }',
    )
    .replace(
      'durable_checkpoint() { :; }',
      () => 'durable_checkpoint() { printf "checkpoint:%s\\n" "$1" >> "$RUNTIME_RAIDERS_TEST_BINARY_LOG"; [ "${RUNTIME_RAIDERS_TEST_KILL_AFTER:-}" != "$1" ] || kill -KILL $$; }',
    )
    .replaceAll(
      '/bin/ln -s "$SHIM" "$command_path"',
      '"$RUNTIME_RAIDERS_TEST_LN" -s "$SHIM" "$command_path"',
    )
    .replace(
      '  /bin/sync\n  plist_replaced=1\n}\n\nremove_migration_directory()',
      '  "$RUNTIME_RAIDERS_TEST_SYNC"\n  plist_replaced=1\n}\n\nremove_migration_directory()',
    )
    .replace(
      '  plist_replaced=1\n  /bin/sync\n}\n\nremove_migration_directory()',
      '  plist_replaced=1\n  "$RUNTIME_RAIDERS_TEST_SYNC"\n}\n\nremove_migration_directory()',
    ));
  chmodSync(path, 0o755);
  return path;
}

function renderedSequenceEightMigrator(root: string): string {
  return renderedProtocolTwoInstaller(root, sequenceEightMigrator);
}

function protocolTwoArtifact(root: string): { zip: string; checksum: string } {
  const stage = join(root, 'protocol-two-stage');
  const container = join(stage, 'Runtime Raiders Release');
  const agent = join(container, 'Runtime Raiders Agent.app');
  const launcher = join(container, 'Runtime Raiders Launcher.app');
  mkdirSync(join(agent, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(launcher, 'Contents/MacOS'), { recursive: true });
  executable(join(agent, 'Contents/MacOS/runtime-raiders-agent'), [
    'collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    'running="$HOME/.runtime-raiders-test-running"',
    'job="$HOME/.runtime-raiders-test-job"',
    'prepared="$HOME/.runtime-raiders-test-prepared"',
    'lease="$HOME/.runtime-raiders-test-lease"',
    'resumed="$HOME/.runtime-raiders-test-resumed"',
    'printf "candidate:%s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_BINARY_LOG"',
    'case "${1:-}" in',
    '  __self-check) printf \'{"companion_version":"0.3.0","release_sequence":9,"release_sha":"' + releaseSHA + '","update_protocol_version":2}\\n\'; exit 0;;',
    '  __runtime-raiders-installer-lease)',
    '    rm -f "$resumed"; : > "$lease"; trap \'rm -f "$lease"\' EXIT HUP INT TERM',
    '    printf \'runtime-raiders-installer-lease-ready\\n\'' ,
    '    cat >/dev/null',
    '    if [ "${FAKE_SIMULATE_LEASE_ABANDONMENT:-0}" = 1 ] && [ -f "$prepared" ]; then',
    '      release_state="$HOME/Library/Application Support/Runtime Raiders/installation/release-state.json"',
    '      if [ -f "$release_state" ] && grep -F \'"release_sequence":9\' "$release_state" >/dev/null 2>&1 && grep -F \'"trial":null\' "$release_state" >/dev/null 2>&1; then',
    '        : > "$resumed"; : > "$running"; printf \'abandonment:resume\\nendpoint /api/runs/events\\nendpoint /api/raiders/heartbeat\\n\' >> "$RUNTIME_RAIDERS_TEST_BINARY_LOG"',
    '      else',
    '        printf \'abandonment:fail-closed\\n\' >> "$RUNTIME_RAIDERS_TEST_BINARY_LOG"',
    '      fi',
    '    fi',
    '    exit 0;;',
    '  __runtime-raiders-legacy-prepare)',
    '    [ -f "$running" ] || exit 69; : > "$prepared"; printf \'prepared for update\\n\'; exit 0;;',
    '  __runtime-raiders-legacy-resume)',
    '    rm -f "$prepared"; : > "$running"; printf \'resumed legacy\\n\'; exit 0;;',
    '  __runtime-raiders-installer-validate-legacy)',
    '    if [ "${FAKE_SEQUENCE8_CANARY_MODE:-0}" = 1 ]; then',
    '      record="$HOME/Library/Application Support/Runtime Raiders/state/command-link"',
    '      [ "$(cat "$record")" = /opt/homebrew/opt/libpq/bin/raiders ]',
    '      [ -L "$RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH" ]',
    '      [ "$(readlink "$RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH")" = "$HOME/Library/Application Support/Runtime Raiders/raiders" ]',
    '      exit $?',
    '    fi',
    '    record="$HOME/Library/Application Support/Runtime Raiders/state/command-link"; command_path="$(cat "$record")"; command_dir="${command_path%/*}"',
    '    case "$command_path" in /*/raiders) ;; *) exit 1;; esac',
    '    case "$command_path" in *//*|*/../*|*/./*) exit 1;; esac',
    '    case "$PATH" in ":"*|*":"|*"::"*) exit 1;; esac; found=0; seen=:',
    '    old_ifs="$IFS"; IFS=:; for component in $PATH; do IFS="$old_ifs"; case "$component" in /*) ;; *) exit 1;; esac; case "$component" in *//*|*/../*|*/./*) exit 1;; esac; [ -d "$component" ] && [ ! -L "$component" ] || exit 1; case "$seen" in *":"$component":"*) exit 1;; esac; seen="$seen$component:"; [ "$component" != "$command_dir" ] || found=1; IFS=:; done; IFS="$old_ifs"; [ "$found" -eq 1 ] || exit 1',
    '    [ -d "$command_dir" ] && [ ! -L "$command_dir" ] && [ "$(/usr/bin/stat -f %u "$command_dir")" = "$(/usr/bin/id -u)" ] && [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$HOME/Library/Application Support/Runtime Raiders/raiders" ]; status=$?; exit "$status";;',
    '  __runtime-raiders-installer-retire-sequence-eight-command)',
    '    [ "${FAKE_SEQUENCE8_CANARY_MODE:-0}" = 1 ] || exit 64',
    '    record="$HOME/Library/Application Support/Runtime Raiders/.migration-v1/old-command-link"',
    '    [ "$(cat "$record")" = /opt/homebrew/opt/libpq/bin/raiders ] || exit 1',
    '    if [ -L "$RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH" ]; then',
    '      [ "$(readlink "$RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH")" = "$HOME/Library/Application Support/Runtime Raiders/raiders" ] || exit 1',
    '      rm -f "$RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH"',
    '    elif [ -e "$RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH" ]; then exit 1; fi',
    '    exit 0;;',
    '  __runtime-raiders-installer-protected-state)',
    '    support="$HOME/Library/Application Support/Runtime Raiders"',
    '    (cd "$support" && for root in state outbox; do if [ -d "$root" ]; then printf "D %s " "$root"; /usr/bin/stat -f "%d:%i:%Lp:%u:%g\\n" "$root"; find "$root" -mindepth 1 \\( -name command-link -o -name path-marker-owned -o -name update.lock -o -name prepared-startup.lock \\) -prune -o -print | sort | while IFS= read -r entry; do if [ -d "$entry" ]; then printf "D %s " "$entry"; /usr/bin/stat -f "%d:%i:%Lp:%u:%g\\n" "$entry"; else printf "F %s " "$entry"; /usr/bin/stat -f "%Lp:%u:%g:%l" "$entry"; /usr/bin/shasum -a 256 "$entry"; fi; done; else printf "M %s\\n" "$root"; fi; done; [ ! -f outbox/large-event.json ] || cat outbox/large-event.json); exit 0;;',
    '  __runtime-raiders-installer-sync-migration) case "${2:-}" in staging-tree|staging-tombstone-tree|active-journal|active-release-state|support-directory) exit 0;; *) exit 64;; esac;;',
    '  __runtime-raiders-installer-status)',
    '    phase="${2:-}"; generation="${3:-}"; intent="${4:-}"; expected_queue="${5:-}"; case "$phase" in legacy-*) expected_queue="$intent";; esac; cat >/dev/null',
    '    [ "${FAKE_STATUS_PEER_MISMATCH:-}" != "$phase" ] || exit 83',
    '    case "$phase" in legacy-*) payload="$(FAKE_STATUS_PHASE="$phase" "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent" status)";; *) payload="$(FAKE_STATUS_PHASE="$phase" "$0" status)";; esac',
    '    [ "${FAKE_STATUS_CORRUPTION:-}" != "$phase" ] || exit 82',
    '    printf "%s" "$payload" | grep -F \'"activeRunCount":0\' >/dev/null',
    '    actual_queue="$(printf "%s" "$payload" | /usr/bin/sed -n \'s/.*"queuedEventCount":\\([0-9][0-9]*\\).*/\\1/p\')"',
    '    case "$actual_queue" in *[!0-9]*|\'\') exit 1;; esac',
    '    [ -z "$expected_queue" ] || [ "$actual_queue" = "$expected_queue" ]',
    '    case "$phase" in',
    '      legacy-running) [ -z "$generation" ] || { [ "$generation" = enabled ] || [ "$generation" = disabled ]; }; printf "%s" "$payload" | grep -F \'"installedReleaseSequence":8\' >/dev/null; printf "%s" "$payload" | grep -F \'"preparedForUpdate":false\' >/dev/null; case "$payload" in *\'"enabled":true\'*) actual_intent=enabled;; *) actual_intent=disabled;; esac; [ -z "$generation" ] || [ "$actual_intent" = "$generation" ]; printf \'%s %s\\n\' "$actual_intent" "$actual_queue";;',
    '      legacy-prepared) [ "$generation" = enabled ] || [ "$generation" = disabled ]; printf "%s" "$payload" | grep -F \'"installedReleaseSequence":8\' >/dev/null; printf "%s" "$payload" | grep -F \'"preparedForUpdate":true\' >/dev/null;;',
    '      candidate-prepared|candidate-resumed) [ "$generation" = 1 ]; [ "$intent" = enabled ] || [ "$intent" = disabled ]; printf "%s" "$payload" | grep -F \'"installedReleaseSequence":9\' >/dev/null; expected=true; [ "$phase" = candidate-resumed ] && expected=false; printf "%s" "$payload" | grep -F "\\\"preparedForUpdate\\\":$expected" >/dev/null; [ "${FAKE_MUTATE_PROTECTED_AT:-}" != "$phase" ] || printf \'mutated\\n\' >> "$collector_state";;',
    '      *) exit 64;;',
    '    esac; exit 0;;',
    '  __runtime-raiders-installer-resume)',
    '    [ "${2:-}" = 1 ] || exit 64; [ -f "$job" ] || exit 69; rm -f "$prepared"; : > "$resumed"; : > "$running"; [ "${FAKE_KILL_DURING_RESUME:-0}" != 1 ] || kill -KILL "$RUNTIME_RAIDERS_TEST_INSTALLER_PID"; printf \'resumed\\n\'; exit 0;;',
    '  uninstall) rm -f "$running"; exit 0;;',
    'esac',
    'state_kind=missing; enabled=false',
    'if [ -f "$collector_state" ]; then',
    '  grep -F \'"enabled":true\' "$collector_state" >/dev/null 2>&1 && { state_kind=enabled; enabled=true; } || state_kind=disabled',
    'fi',
    'daemon=false; [ -f "$running" ] && daemon=true',
    'prepared_value=false; prepared_generation=null; { [ -f "$prepared" ] || [ -f "$lease" ]; } && [ ! -f "$resumed" ] && { prepared_value=true; prepared_generation=1; }',
    'queued_event_count="${FAKE_QUEUED_EVENT_COUNT:-0}"; [ "${FAKE_STATUS_QUEUE_CONFLICT_AT:-}" != "${FAKE_STATUS_PHASE:-}" ] || queued_event_count=$((queued_event_count + 1))',
    'if [ "${1:-}" = status ]; then',
    '  printf \'{"activeRunCount":%s,"availableCompanionVersion":null,"availableReleaseSequence":null,"compiledAdapters":["claude_code","unavailable","codex_cli","available","codex_desktop","available","omp","unavailable"],"daemonRunning":%s,"enabled":%s,"installedCompanionVersion":"0.3.0","installedReleaseSequence":9,"lastSuccessfulUploadMS":null,"persistedState":"%s","preparedForUpdate":%s,"preparedReleaseStateGeneration":%s,"queuedEventCount":%s,"serverEnabledSurfaces":["codex_cli","codex_desktop"],"updateCommand":null}\\n\' "${FAKE_ACTIVE_RUN_COUNT:-0}" "$daemon" "$enabled" "$state_kind" "$prepared_value" "$prepared_generation" "$queued_event_count"; exit 0',
    'fi',
    'exit 64',
  ]);
  writeFileSync(join(agent, 'Contents/Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-agent</string>',
    '<key>CFBundleShortVersionString</key><string>0.3.0</string>',
    '<key>RuntimeRaidersReleaseSequence</key><integer>9</integer>',
    `<key>RuntimeRaidersReleaseSHA</key><string>${releaseSHA}</string>`,
    '<key>RuntimeRaidersUpdateProtocolVersion</key><integer>2</integer>',
    '</dict></plist>',
    '',
  ].join('\n'));
  executable(join(launcher, 'Contents/MacOS/runtime-raiders-launcher'), [
    'support="$HOME/Library/Application Support/Runtime Raiders"',
    'exec "$support/releases/sequence-9-' + releaseSHA + '/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent" "$@"',
  ]);
  writeFileSync(join(launcher, 'Contents/Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-launcher</string>',
    '<key>CFBundleShortVersionString</key><string>1.0.0</string>',
    '<key>RuntimeRaidersLauncherProtocolVersion</key><integer>1</integer>',
    '</dict></plist>',
    '',
  ].join('\n'));
  const zip = join(root, 'runtime-raiders-agent.zip');
  execFileSync('zip', ['-qry', zip, 'Runtime Raiders Release'], { cwd: stage });
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
    'verify=0; requirement=""; target=""',
    'for argument in "$@"; do target="$argument"; [ "$argument" = "--verify" ] && verify=1; [ "$argument" = "-R" ] && exit 65; case "$argument" in -R=*) requirement="$argument";; esac; done',
    'case "$target" in *"Runtime Raiders Launcher.app") printf "%s\\n" "$requirement" | grep -F "identifier \\"com.redlattice.runtime-raiders-launcher\\"" >/dev/null;; *) printf "%s\\n" "$requirement" | grep -F "identifier \\"com.redlattice.runtime-raiders-agent\\"" >/dev/null;; esac',
    '[ "$verify" = 0 ] || [ -n "$requirement" ]',
    '[ "$FAKE_CODESIGN_FAIL" != 1 ]',
  ]);
  executable(join(bin, 'ln'), [
    '[ "$FAKE_LN_FAIL" != 1 ] || exit 76',
    'if [ "$FAKE_LN_MUTATES_THEN_FAIL" = 1 ] && [ ! -f "$HOME/.runtime-raiders-test-ln-failed" ]; then last=""; for value in "$@"; do last="$value"; done; rm -f "$last"; : > "$HOME/.runtime-raiders-test-ln-failed"; exit 76; fi',
    'exec /bin/ln "$@"',
  ]);
  executable(join(bin, 'rm'), [
    'last=""; for value in "$@"; do last="$value"; done',
    'case "$last" in',
    '  *"/.migration-v1.tombstone"*)',
    '    if [ "${FAKE_KILL_DURING_TOMBSTONE_DELETE:-0}" = 1 ]; then',
    '      [ ! -f "$last" ] || /bin/rm -f "$last"',
    '      kill -KILL "$RUNTIME_RAIDERS_TEST_INSTALLER_PID"',
    '      exit 137',
    '    fi;;',
    'esac',
    'exec /bin/rm "$@"',
  ]);
  executable(join(bin, 'ditto'), [
    'printf "ditto %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    'exec /usr/bin/ditto "$@"',
  ]);
  executable(join(bin, 'chmod'), [
    'case "$2" in */path-marker-owned) [ "$FAKE_CHMOD_FAIL_MARKER" != 1 ] || exit 75;; esac',
    'exec /bin/chmod "$@"',
  ]);
  executable(join(bin, 'launchctl'), [
      'running="$HOME/.runtime-raiders-test-running"',
    'job="$HOME/.runtime-raiders-test-job"',
    'lease="$HOME/.runtime-raiders-test-lease"',
    'prepared="$HOME/.runtime-raiders-test-prepared"',
    'polls="$HOME/.runtime-raiders-test-polls"',
    'if [ "$1" = print ]; then',
    '  [ "$FAKE_LAUNCH_PRINT_PRESENT" = 1 ] && exit 0',
    '  [ "$FAKE_LAUNCH_PRINT_ABSENT" = 1 ] && { printf "Could not find service\\n" >&2; exit 113; }',
    '  [ "$FAKE_LAUNCH_PRINT_AMBIGUOUS" != 1 ] || { printf "launchctl print ambiguous failure\\n" >&2; exit 77; }',
    '  [ -f "$job" ] && exit 0',
    '  printf "Could not find service\\n" >&2; exit 113',
    'fi',
    'if [ "$1" = bootout ] && [ "$FAKE_BOOTOUT_STOPS_THEN_FAIL" = 1 ]; then rm -f "$job" "$running" "$polls"; printf "bootout stopped then failed\\n" >&2; exit 77; fi',
    'if [ "$1" = bootout ] && [ "$FAKE_LAUNCH_BOOTOUT_FAIL" = 1 ]; then printf "bootout ambiguous failure\\n" >&2; exit 77; fi',
    'if [ "$1" = bootstrap ] && [ "$FAKE_BOOTSTRAP_STARTS_THEN_FAIL" = 1 ]; then : > "$job"; : > "$running"; printf "bootstrap started then failed\\n" >&2; exit 77; fi',
    'if [ "$1" = bootstrap ] && [ "$FAKE_LAUNCH_BOOTSTRAP_FAIL" = 1 ]; then printf "bootstrap failure\\n" >&2; exit 77; fi',
    'if [ "$1" = bootstrap ] && [ "$FAKE_LAUNCH_REQUIRE_OFF" = 1 ]; then',
    '  collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    '  grep -F \'"enabled":false\' "$collector_state" >/dev/null 2>&1 || { printf "bootstrap observed collection enabled\\n" >&2; exit 78; }',
    'fi',
    'if [ "$1" = bootout ]; then rm -f "$job" "$running" "$polls"; fi',
    'if [ "$1" = bootstrap ]; then',
    '  collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    '  bootstrap_count_file="$HOME/.runtime-raiders-test-bootstrap-count"; bootstrap_count=0; [ ! -f "$bootstrap_count_file" ] || bootstrap_count="$(cat "$bootstrap_count_file")"; bootstrap_count=$((bootstrap_count + 1)); printf "%s\\n" "$bootstrap_count" > "$bootstrap_count_file"',
    '  if [ "$FAKE_MUTATE_PROTECTED_DURING_ROLLBACK" = 1 ] && [ "$bootstrap_count" -gt 1 ]; then mkdir -p "$HOME/Library/Application Support/Runtime Raiders/outbox/rollback-mutation"; chmod 700 "$HOME/Library/Application Support/Runtime Raiders/outbox/rollback-mutation"; fi',
    '  if [ -f "$lease" ]; then : > "$prepared"; elif ! grep -F \'"enabled":false\' "$collector_state" >/dev/null 2>&1; then',
    '    printf "endpoint /api/runs/events\\nendpoint /api/raiders/heartbeat\\n" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    '  fi',
    '  : > "$job"; : > "$running"; rm -f "$polls"',
    'fi',
    'printf "launchctl %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
  ]);
  executable(join(bin, 'uuidgen'), ['printf "%s\\n" "00000000-0000-4000-8000-000000000001"']);
  executable(join(bin, 'sleep'), ['printf "sleep %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"']);
  executable(join(bin, 'sync'), [
    '[ "${FAKE_SYNC_FAIL:-0}" != 1 ] || exit 74',
    'exec /bin/sync "$@"',
  ]);
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
    FAKE_LN_MUTATES_THEN_FAIL: '0',
    FAKE_CHMOD_FAIL_MARKER: '0',
    FAKE_LAUNCH_PRINT_PRESENT: '0',
    FAKE_LAUNCH_PRINT_ABSENT: '0',
    FAKE_LAUNCH_PRINT_AMBIGUOUS: '0',
    FAKE_LAUNCH_BOOTOUT_FAIL: '0',
    FAKE_LAUNCH_BOOTSTRAP_FAIL: '0',
    FAKE_BOOTOUT_STOPS_THEN_FAIL: '0',
    FAKE_BOOTSTRAP_STARTS_THEN_FAIL: '0',
    FAKE_LAUNCH_REQUIRE_OFF: '0',
    FAKE_DAEMON_READY_AFTER: '1',
    FAKE_DAEMON_NEVER_READY: '0',
    FAKE_CURL_REDIRECT: '',
    FAKE_INSTALLER_VALIDATOR_FAIL: '',
    FAKE_STATUS_CORRUPTION: '',
    FAKE_MUTATE_PROTECTED_AT: '',
    FAKE_MUTATE_PROTECTED_DURING_ROLLBACK: '0',
    FAKE_SIMULATE_LEASE_ABANDONMENT: '0',
    FAKE_KILL_DURING_TOMBSTONE_DELETE: '0',
    FAKE_SYNC_FAIL: '0',
    FAKE_STATUS_PEER_MISMATCH: '',
    FAKE_CODE_FILE_OWNER: '',
    RUNTIME_RAIDERS_TEST_CODE_FILE: '',
    RUNTIME_RAIDERS_TEST_LOG: join(home, 'commands.log'),
    RUNTIME_RAIDERS_TEST_BINARY_LOG: join(home, 'binary.log'),
    RUNTIME_RAIDERS_TEST_ZIP: files.zip,
    RUNTIME_RAIDERS_TEST_CHECKSUM: files.checksum,
    RUNTIME_RAIDERS_TEST_LN: join(fake, 'ln'),
    RUNTIME_RAIDERS_TEST_SYNC: join(fake, 'sync'),
    RUNTIME_RAIDERS_TEST_ENROLLMENT: JSON.stringify({
      device_token: token, dedupe_secret: secret, server_url: 'https://raiders.redlattice.com',
      cutover_at: 1700000000000, enabled_surfaces: ['codex_desktop', 'codex_cli'],
    }),
  };
}

function invoke(file: string, args: string[], environment: NodeJS.ProcessEnv) {
  return spawnSync('bash', [file, ...args], { env: environment, encoding: 'utf8' });
}

async function waitForFile(path: string, timeoutMilliseconds = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function interruptProcessGroup(
  file: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  readyFile: string,
): Promise<{ status: number | null; stderr: string }> {
  const child = spawn('/bin/bash', [file, ...args], {
    detached: true,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    await waitForFile(readyFile);
    process.kill(-child.pid!, 'SIGTERM');
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve));
    return { status, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
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

type ReleaseBuilderFixture = {
  build: string;
  releaseValidatorBuild: string;
  repository: string;
  releaseSHA: string;
};

type ReleaseBuilderFixtureOptions = {
  interceptAbsoluteDitto?: boolean;
  crossWireArm64Slice?: 'agent' | 'launcher';
  rendererFailure?: boolean;
  oversizedRenderer?: boolean;
  installerMaxBytes?: number;
};

function disposableReleaseBuilder(
  root: string,
  options: ReleaseBuilderFixtureOptions = {},
): ReleaseBuilderFixture {
  const repository = join(root, 'repository');
  const fixtureBuild = join(repository, 'scripts/release/build-runtime-raiders-agent.sh');
  const fixtureRenderer = join(repository, 'scripts/release/render-runtime-raiders-installer.sh');
  const fixtureValidatorBuilder = join(repository, 'scripts/release/build-runtime-raiders-release-validator.sh');
  const fixtureMachoUUIDSource = join(repository, 'scripts/release/runtime-raiders-macho-uuid.c');
  const fixtureInstaller = join(repository, 'companion/packaging/install.sh');
  mkdirSync(join(repository, 'scripts/release'), { recursive: true });
  mkdirSync(join(repository, 'scripts/lib'), { recursive: true });
  mkdirSync(join(repository, 'companion/packaging'), { recursive: true });
  mkdirSync(join(repository, 'config'), { recursive: true });
  let fixtureBuildContents = readFileSync(build, 'utf8');
  if (options.interceptAbsoluteDitto) {
    fixtureBuildContents = fixtureBuildContents.replaceAll(
      '/usr/bin/ditto',
      '"$RUNTIME_RAIDERS_TEST_DITTO"',
    );
  }
  if (options.crossWireArm64Slice === 'agent') {
    fixtureBuildContents = fixtureBuildContents.replace(
      'lipo -create "$WORK/raiders-arm64" "$WORK/raiders-x86_64" -output "$WORK/runtime-raiders-agent"',
      'lipo -create "$WORK/runtime-raiders-launcher-arm64" "$WORK/raiders-x86_64" -output "$WORK/runtime-raiders-agent"',
    );
  }
  if (options.crossWireArm64Slice === 'launcher') {
    fixtureBuildContents = fixtureBuildContents.replace(
      'lipo -create "$WORK/runtime-raiders-launcher-arm64" "$WORK/runtime-raiders-launcher-x86_64" -output "$WORK/runtime-raiders-launcher"',
      'lipo -create "$WORK/raiders-arm64" "$WORK/runtime-raiders-launcher-x86_64" -output "$WORK/runtime-raiders-launcher"',
    );
  }
  writeFileSync(fixtureBuild, fixtureBuildContents);
  let fixtureRendererContents = options.rendererFailure
    ? '#!/bin/sh\nexit 89\n'
    : readFileSync(installerRenderer, 'utf8');
  if (options.oversizedRenderer) {
    fixtureRendererContents = [
      '#!/bin/sh',
      'set -eu',
      'OUTPUT="$8"',
      '/bin/dd if=/dev/zero bs=1048576 count=9 of="$OUTPUT" 2>/dev/null',
      'chmod 755 "$OUTPUT"',
      '',
    ].join('\n');
  }
  writeFileSync(fixtureRenderer, fixtureRendererContents, { mode: 0o700 });
  writeFileSync(
    fixtureValidatorBuilder,
    readFileSync(releaseValidatorBuilder, 'utf8')
      .replaceAll('/usr/bin/swift', 'swift')
      .replaceAll('/usr/bin/clang', 'clang')
      .replaceAll('/usr/bin/codesign', 'validator-codesign')
      .replaceAll('/usr/bin/strip', 'strip')
      .replaceAll('/usr/bin/lipo', 'lipo'),
    { mode: 0o700 },
  );
  writeFileSync(fixtureMachoUUIDSource, readFileSync(machoUUIDSource));
  writeFileSync(fixtureInstaller, readFileSync(installer));
  writeFileSync(join(repository, 'scripts/lib/runtime-raiders-artifact-contract.mjs'), readFileSync(artifactContractTool));
  writeFileSync(
    join(repository, 'config/runtime-raiders-artifact-contract.json'),
    options.installerMaxBytes === undefined
      ? readFileSync(artifactContract)
      : JSON.stringify({ schema_version: 1, installer_max_bytes: options.installerMaxBytes }) + '\n',
  );
  writeFileSync(join(repository, 'companion/RELEASE'), readFileSync(join(process.cwd(), 'companion/RELEASE')));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Release Test'], { cwd: repository });
  execFileSync('/usr/bin/git', ['add', 'scripts/release/build-runtime-raiders-agent.sh', 'scripts/release/build-runtime-raiders-release-validator.sh', 'scripts/release/runtime-raiders-macho-uuid.c', 'scripts/release/render-runtime-raiders-installer.sh', 'scripts/lib/runtime-raiders-artifact-contract.mjs', 'config/runtime-raiders-artifact-contract.json', 'companion/packaging/install.sh', 'companion/RELEASE'], { cwd: repository });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'release fixture'], { cwd: repository });
  const fixtureSHA = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  return {
    build: fixtureBuild,
    releaseValidatorBuild: fixtureValidatorBuilder,
    repository,
    releaseSHA: fixtureSHA,
  };
}

function releaseBuildArgs(sha: string, ...args: string[]): string[] {
  return ['--release-sha', sha, ...args];
}

function immutableReleaseOutput(
  root: string,
  fixture: ReleaseBuilderFixture,
  namespace = 'release-output',
): string {
  const parent = join(root, namespace);
  mkdirSync(parent, { recursive: true });
  return join(parent, `sequence-${releaseSequence}-${fixture.releaseSHA}`);
}

function writeEnrollment(home: string): string {
  const state = join(home, 'Library/Application Support/Runtime Raiders/state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const enrollment = join(state, 'enrollment.json');
  writeFileSync(enrollment, JSON.stringify({
    version: 1,
    device_id: '00000000-0000-4000-8000-000000000001',
    device_token: token,
    dedupe_secret: secret,
    server_url: 'https://raiders.redlattice.com',
    cutover_at: 1700000000000,
    enabled_surfaces: ['codex_desktop', 'codex_cli'],
  }) + '\n');
  chmodSync(enrollment, 0o600);
  return enrollment;
}

type LegacyFixture = {
  home: string;
  support: string;
  app: string;
  executable: string;
  plist: string;
  shim: string;
  commandPath: string;
  enrollment: string;
  collectorState: string;
  environment: NodeJS.ProcessEnv;
};

function canonicalLegacyPlist(executablePath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.redlattice.runtime-raiders-agent</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${executablePath}</string>`,
    '    <string>daemon</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function canonicalLegacyShim(
  home: string,
  support: string,
  executablePath: string,
  commandLinkFile: string,
): string {
  const plist = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const shim = join(support, 'raiders');
  const markerFlag = join(support, 'state/path-marker-owned');
  return [
    '#!/bin/sh',
    'set -eu',
    `SUPPORT='${support}'`,
    `PLIST='${plist}'`,
    `SHIM='${shim}'`,
    `COMMAND_LINK_FILE='${commandLinkFile}'`,
    `MARKER_FLAG='${markerFlag}'`,
    'MARKER=\'export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path\'',
    `LABEL='${label}'`,
    `binary='${executablePath}'`,
    'job_absent() {',
    '  output="$(mktemp /tmp/runtime-raiders-launchctl.XXXXXX)"',
    '  if launchctl print "gui/$(id -u)/$LABEL" >"$output" 2>&1; then',
    '    rm -f "$output"',
    '    return 1',
    '  else',
    '    print_status=$?',
    '  fi',
    '  [ "$print_status" -eq 113 ] || { rm -f "$output"; return 1; }',
    '  grep -F \'Could not find service\' "$output" >/dev/null 2>&1',
    '  status=$?',
    '  rm -f "$output"',
    '  return $status',
    '}',
    'if [ "$#" -eq 0 ] || [ "$1" != uninstall ]; then',
    '  exec "$binary" "$@"',
    'fi',
    'if "$binary" uninstall; then',
    '  launchctl bootout "gui/$(id -u)" "$PLIST" || {',
    '    echo "Runtime Raiders bootout failed; refusing cleanup" >&2',
    '    exit 1',
    '  }',
    '  job_absent || {',
    '    echo "Runtime Raiders launchd job still present; refusing cleanup" >&2',
    '    exit 1',
    '  }',
    'elif [ ! -S "$SUPPORT/agent.sock" ] && job_absent; then',
    '  :',
    'else',
    '  echo "Runtime Raiders daemon did not safely stop; refusing cleanup" >&2',
    '  exit 1',
    'fi',
    'if [ -f "$COMMAND_LINK_FILE" ]; then',
    '  command_path="$(cat "$COMMAND_LINK_FILE")"',
    '  if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ]; then',
    '    rm -f "$command_path"',
    '  fi',
    'fi',
    'profile="$HOME/.zprofile"',
    'if [ -f "$MARKER_FLAG" ] && [ -f "$profile" ]; then',
    '  temporary="$(mktemp "$profile.runtime-raiders.XXXXXX")"',
    '  awk -v marker="$MARKER" \'seen == 0 && $0 == marker { seen = 1; next } { print }\' "$profile" > "$temporary"',
    '  mv "$temporary" "$profile"',
    'fi',
    'rm -f "$PLIST"',
    'rm -rf "$SUPPORT"',
    '',
  ].join('\n');
}

function legacySequenceEightFixture(
  root: string,
  enabled: boolean,
  queuedEventCount = 0,
): LegacyFixture {
  const home = join(root, 'home');
  const support = join(home, 'Library/Application Support/Runtime Raiders');
  const state = join(support, 'state');
  const app = join(support, 'Runtime Raiders Agent.app');
  const executablePath = join(app, 'Contents/MacOS/runtime-raiders-agent');
  const plist = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const shim = join(support, 'raiders');
  const commandDir = join(home, '.local/bin');
  const homebrew = join(root, 'external-root/opt/homebrew');
  const homebrewOpt = join(homebrew, 'opt');
  const homebrewCellar = join(homebrew, 'Cellar');
  const physicalBin = join(homebrewCellar, 'libpq/18.4/bin');
  const commandPath = join(physicalBin, 'raiders');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(support, 'outbox'), { recursive: true });
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(homebrewOpt, { recursive: true });
  mkdirSync(physicalBin, { recursive: true });
  for (const directory of [support, state, join(support, 'outbox'), join(home, '.local'), commandDir]) chmodSync(directory, 0o700);
  chmodSync(join(root, 'external-root/opt'), 0o755);
  chmodSync(homebrew, 0o755);
  chmodSync(homebrewOpt, 0o775);
  chmodSync(homebrewCellar, 0o775);
  for (const directory of [join(homebrewCellar, 'libpq'), join(homebrewCellar, 'libpq/18.4'), physicalBin]) {
    chmodSync(directory, 0o755);
  }
  symlinkSync('../Cellar/libpq/18.4', join(homebrewOpt, 'libpq'));
  chmodSync(app, 0o700);
  executable(executablePath, [
    'collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    'running="$HOME/.runtime-raiders-test-running"',
    'prepared="$HOME/.runtime-raiders-test-prepared"',
    'if [ "${1:-}" = status ]; then',
    '  enabled=false; state=disabled; grep -F \'"enabled":true\' "$collector_state" >/dev/null 2>&1 && { enabled=true; state=enabled; }',
    '  daemon=false; [ -f "$running" ] && daemon=true',
    '  prepared_value=false; [ -f "$prepared" ] && prepared_value=true',
    '  queued_event_count="${FAKE_QUEUED_EVENT_COUNT:-0}"; [ "${FAKE_STATUS_QUEUE_CONFLICT_AT:-}" != "${FAKE_STATUS_PHASE:-}" ] || queued_event_count=$((queued_event_count + 1))',
    '  printf \'{"activeRunCount":%s,"availableCompanionVersion":null,"availableReleaseSequence":null,"compiledAdapters":["claude_code","unavailable","codex_cli","available","codex_desktop","available","omp","unavailable"],"daemonRunning":%s,"enabled":%s,"installedCompanionVersion":"0.2.6","installedReleaseSequence":8,"lastSuccessfulUploadMS":null,"persistedState":"%s","preparedForUpdate":%s,"queuedEventCount":%s,"serverEnabledSurfaces":["codex_cli","codex_desktop"],"updateCommand":null}\\n\' "${FAKE_ACTIVE_RUN_COUNT:-0}" "$daemon" "$enabled" "$state" "$prepared_value" "$queued_event_count"; exit 0',
    'fi',
    'exit 64',
  ]);
  writeFileSync(join(app, 'Contents/Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.redlattice.runtime-raiders-agent</string>',
    '<key>CFBundleShortVersionString</key><string>0.2.6</string>',
    '<key>RuntimeRaidersReleaseSequence</key><integer>8</integer>',
    `<key>RuntimeRaidersReleaseSHA</key><string>${legacyReleaseSHA}</string>`,
    '<key>RuntimeRaidersUpdateProtocolVersion</key><integer>1</integer>',
    '</dict></plist>',
    '',
  ].join('\n'));
  const commandLinkFile = join(state, 'command-link');
  const oldPlist = canonicalLegacyPlist(executablePath);
  const oldShim = canonicalLegacyShim(home, support, executablePath, commandLinkFile);
  writeFileSync(plist, oldPlist); chmodSync(plist, 0o600);
  writeFileSync(shim, oldShim); chmodSync(shim, 0o700);
  symlinkSync(shim, commandPath);
  writeFileSync(join(physicalBin, 'psql'), 'unrelated homebrew command\n');
  writeFileSync(commandLinkFile, '/opt/homebrew/opt/libpq/bin/raiders\n'); chmodSync(commandLinkFile, 0o600);
  const enrollment = writeEnrollment(home);
  const collectorState = join(state, 'collector-state.json');
  writeFileSync(collectorState, `{"enabled":${enabled},"files":{"cursor":"preserve"},"version":1}\n`);
  chmodSync(collectorState, 0o600);
  for (let index = 0; index < queuedEventCount; index += 1) {
    const queued = join(support, 'outbox', `event-${index}.json`);
    writeFileSync(queued, `{"event":"opaque-${index}"}\n`);
    chmodSync(queued, 0o600);
  }
  for (const evidence of [
    'Runtime Raiders Agent.rollback.app/evidence',
    'Runtime Raiders Agent.failed.app/evidence',
    'diagnostics/sequence-3/evidence',
    '.updates/sequence-8/evidence',
  ]) {
    const path = join(support, evidence);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `legacy:${evidence}\n`);
  }
  writeFileSync(join(home, '.runtime-raiders-test-job'), 'old-job\n');
  writeFileSync(join(home, '.runtime-raiders-test-running'), 'old-daemon\n');
  const fake = fakes(root);
  const files = protocolTwoArtifact(root);
  return {
    home, support, app, executable: executablePath, plist, shim, commandPath, enrollment, collectorState,
    environment: {
      ...env(home, fake, files, commandDir),
      FAKE_QUEUED_EVENT_COUNT: String(queuedEventCount),
      FAKE_SEQUENCE8_CANARY_MODE: '1',
      RUNTIME_RAIDERS_TEST_LEGACY_COMMAND_PATH: commandPath,
    },
  };
}

function releaseStatePath(support: string): string {
  return join(support, 'installation/release-state.json');
}

describe('Runtime Raiders protocol-two installer', () => {
  it('keeps sequence-eight compatibility out of the permanent public installer', () => {
    const publicSource = readFileSync(installer, 'utf8');
    const oneTimeSource = readFileSync(sequenceEightMigrator, 'utf8');

    for (const oneTimeOnlySurface of [
      legacyReleaseSHA,
      '/opt/homebrew/opt/libpq/bin/raiders',
      '.migration-v1',
      '__runtime-raiders-legacy-prepare',
      '__runtime-raiders-installer-validate-legacy',
    ]) {
      expect(publicSource).not.toContain(oneTimeOnlySurface);
      expect(oneTimeSource).toContain(oneTimeOnlySurface);
    }
    expect(oneTimeSource).not.toContain('ENROLL_URL=');
    expect(oneTimeSource).not.toContain('--code-file');
    expect(oneTimeSource).not.toContain('strict_current_path_contains');
  });

  it('the public installer refuses the sequence-eight canary without mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-public-refuses-legacy-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const appBefore = buildCacheIdentity(fixture.app);
      const commandBefore = readlinkSync(fixture.commandPath);
      const recordBefore = readFileSync(join(fixture.support, 'state/command-link'));
      const publicTemplate = join(root, 'public-install-template.sh');
      writeFileSync(publicTemplate, readFileSync(installer), { mode: 0o700 });

      const result = invoke(
        renderedProtocolTwoInstaller(root, publicTemplate),
        [],
        fixture.environment,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('reviewed one-time canary migrator');
      expect(buildCacheIdentity(fixture.app)).toEqual(appBefore);
      expect(readlinkSync(fixture.commandPath)).toBe(commandBefore);
      expect(readFileSync(join(fixture.support, 'state/command-link'))).toEqual(recordBefore);
      const commandLog = join(fixture.home, 'commands.log');
      expect(existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '').toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fresh install always uses HOME local bin instead of a writable PATH directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-fresh-command-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const result = invoke(renderedProtocolTwoInstaller(root), installerArgs(root), env(home, fake, files));
      expect(result.status, result.stderr + result.stdout).toBe(0);

      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const canonicalCommand = join(home, '.local/bin/raiders');
      expect(readFileSync(join(support, 'state/command-link'), 'utf8'))
        .toBe(`${canonicalCommand}\n`);
      expect(readlinkSync(canonicalCommand)).toBe(join(support, 'raiders'));
      expect(existsSync(join(fake, 'raiders'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fresh protocol two install creates generation one active only and starts off', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-fresh-v2-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const result = invoke(renderedProtocolTwoInstaller(root), installerArgs(root), env(home, fake, files));
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const support = join(home, 'Library/Application Support/Runtime Raiders');
      const state = JSON.parse(readFileSync(releaseStatePath(support), 'utf8'));
      expect(state).toEqual({
        schema_version: 1,
        generation: 1,
        active: {
          release_sequence: 9,
          release_sha: releaseSHA,
          companion_version: '0.3.0',
          update_protocol_version: 2,
        },
        fallback: null,
        trial: null,
      });
      expect(existsSync(join(support, 'launcher/Runtime Raiders Launcher.app'))).toBe(true);
      expect(existsSync(join(support, `releases/sequence-9-${releaseSHA}/Runtime Raiders Agent.app`))).toBe(true);
      expect(existsSync(join(support, 'Runtime Raiders Agent.app'))).toBe(false);
      expect(readFileSync(join(support, 'state/collector-state.json'), 'utf8')).toContain('"enabled":false');
      expect(readFileSync(join(home, 'commands.log'), 'utf8')).not.toContain('/api/runs/events');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('existing enrollment is accepted before TTY or code input and no enrollment endpoint is called', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-existing-enrollment-'));
    try {
      const home = join(root, 'home'); mkdirSync(home); writeEnrollment(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const before = readFileSync(join(home, 'Library/Application Support/Runtime Raiders/state/enrollment.json'));
      const result = invoke(renderedProtocolTwoInstaller(root), [], env(home, fake, files));
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(readFileSync(join(home, 'Library/Application Support/Runtime Raiders/state/enrollment.json'))).toEqual(before);
      expect(readFileSync(join(home, 'commands.log'), 'utf8')).not.toContain('/api/raiders/enroll');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])('sequence eight migration preserves legacy bytes and intent enabled=%s', (enabled) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-sequence-eight-'));
    try {
      const fixture = legacySequenceEightFixture(root, enabled);
      const appBefore = buildCacheIdentity(fixture.app);
      const inodeBefore = statSync(fixture.app).ino;
      const enrollmentBefore = readFileSync(fixture.enrollment);
      const stateBefore = readFileSync(fixture.collectorState);
      const evidenceRoots = [
        'Runtime Raiders Agent.rollback.app',
        'Runtime Raiders Agent.failed.app',
        'diagnostics',
        '.updates',
      ].map((name) => join(fixture.support, name));
      const evidenceBefore = evidenceRoots.map(buildCacheIdentity);
      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(statSync(fixture.app).ino).toBe(inodeBefore);
      expect(buildCacheIdentity(fixture.app)).toEqual(appBefore);
      expect(readFileSync(fixture.enrollment)).toEqual(enrollmentBefore);
      expect(readFileSync(fixture.collectorState)).toEqual(stateBefore);
      expect(evidenceRoots.map(buildCacheIdentity)).toEqual(evidenceBefore);
      expect(existsSync(fixture.commandPath)).toBe(false);
      expect(readFileSync(join(fixture.commandPath, '../psql'), 'utf8'))
        .toBe('unrelated homebrew command\n');
      const canonicalCommand = join(fixture.home, '.local/bin/raiders');
      expect(readlinkSync(canonicalCommand)).toBe(fixture.shim);
      expect(readFileSync(join(fixture.support, 'state/command-link'), 'utf8'))
        .toBe(`${canonicalCommand}\n`);
      expect(JSON.parse(readFileSync(releaseStatePath(fixture.support), 'utf8')).fallback).toBeNull();
      expect(readFileSync(fixture.plist, 'utf8')).toContain('/launcher/Runtime Raiders Launcher.app/');
      expect(readFileSync(fixture.shim, 'utf8')).toContain('/launcher/Runtime Raiders Launcher.app/');
      const binaryLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(binaryLog.indexOf('__runtime-raiders-legacy-prepare')).toBeLessThan(binaryLog.indexOf('__runtime-raiders-installer-resume 1'));
      expect(readFileSync(fixture.collectorState, 'utf8')).toContain(`"enabled":${enabled}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('restores the legacy plist after its replacement fails durability sync and permits retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-plist-sync-rollback-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const plistBefore = readFileSync(fixture.plist);
      const failed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_SYNC_FAIL: '1',
      });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(fixture.plist)).toEqual(plistBefore);

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr + retry.stdout).toBe(0);
      expect(readFileSync(fixture.plist, 'utf8')).toContain(
        '/launcher/Runtime Raiders Launcher.app/',
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])(
    'sequence eight migration preserves a nonempty outbox and intent enabled=%s',
    (enabled) => {
      const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-sequence-eight-queued-'));
      try {
        const fixture = legacySequenceEightFixture(root, enabled, 3);
        const outbox = join(fixture.support, 'outbox');
        const outboxBefore = buildCacheIdentity(outbox);
        const stateBefore = readFileSync(fixture.collectorState);
        const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(buildCacheIdentity(outbox)).toEqual(outboxBefore);
        expect(readFileSync(fixture.collectorState)).toEqual(stateBefore);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('recovers a real near-50 MiB protected outbox after SIGKILL', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-large-outbox-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 1);
      const large = join(fixture.support, 'outbox/large-event.json');
      writeFileSync(large, Buffer.alloc(49 * 1024 * 1024, 0x41), { mode: 0o600 });
      const before = createHash('sha256').update(readFileSync(large)).digest('hex');
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_KILL_AFTER: 'after-journal-activation',
      });
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr + retry.stdout).toBe(0);
      expect(createHash('sha256').update(readFileSync(large)).digest('hex')).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('fails closed on a matching-digest protected snapshot above the finite migration cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-oversize-snapshot-'));
    try {
      const fixture = legacySequenceEightFixture(root, false, 1);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_KILL_AFTER: 'after-journal-activation',
      });
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const migration = join(fixture.support, '.migration-v1');
      const snapshot = join(migration, 'protected-before');
      truncateSync(snapshot, 128 * 1024 * 1024 + 1);
      chmodSync(snapshot, 0o600);
      const digest = execFileSync('/usr/bin/shasum', ['-a', '256', snapshot], { encoding: 'utf8' })
        .split(/\s+/, 1)[0];
      const journalPath = join(migration, 'journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      journal.protected_sha256 = digest;
      writeFileSync(journalPath, JSON.stringify(journal) + '\n', { mode: 0o600 });

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status).not.toBe(0);
      expect(existsSync(migration)).toBe(true);
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-running'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it.each(['legacy-prepared', 'candidate-prepared', 'candidate-resumed'] as const)(
    'rejects a conflicting %s queued-event status without changing the outbox',
    (phase) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-queued-conflict-${phase}-`));
      try {
        const fixture = legacySequenceEightFixture(root, false, 3);
        const outbox = join(fixture.support, 'outbox');
        const outboxBefore = buildCacheIdentity(outbox);
        const failed = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          FAKE_STATUS_QUEUE_CONFLICT_AT: phase,
        });
        expect(failed.status).not.toBe(0);
        expect(buildCacheIdentity(outbox)).toEqual(outboxBefore);
        expect(readlinkSync(fixture.commandPath)).toBe(fixture.shim);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('migration rollback restores the flat arrangement at every replacement boundary and permits retry', () => {
    const checkpoints = [
      'archive-verification', 'enrollment-decision', 'prepare', 'old-job-stop',
      'launcher-directory', 'releases-directory', 'installation-directory',
      'launcher-placement', 'release-placement', 'plist-replacement',
      'shim-replacement', 'command-link-replacement', 'bootstrap', 'prepared-health',
    ];
    for (const checkpoint of checkpoints) {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-rollback-${checkpoint}-`));
      try {
        const fixture = legacySequenceEightFixture(root, true, 3);
        const appBefore = buildCacheIdentity(fixture.app);
        const inodeBefore = statSync(fixture.app).ino;
        const plistBefore = readFileSync(fixture.plist);
        const shimBefore = readFileSync(fixture.shim);
        const enrollmentBefore = readFileSync(fixture.enrollment);
        const stateBefore = readFileSync(fixture.collectorState);
        const outboxBefore = buildCacheIdentity(join(fixture.support, 'outbox'));
        const failed = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          RUNTIME_RAIDERS_TEST_FAIL_AFTER: checkpoint,
        });
        expect(failed.status, `${checkpoint}: ${failed.stderr}`).not.toBe(0);
        expect(statSync(fixture.app).ino, checkpoint).toBe(inodeBefore);
        expect(buildCacheIdentity(fixture.app), checkpoint).toEqual(appBefore);
        expect(readFileSync(fixture.plist), checkpoint).toEqual(plistBefore);
        expect(readFileSync(fixture.shim), checkpoint).toEqual(shimBefore);
        expect(readlinkSync(fixture.commandPath), checkpoint).toBe(fixture.shim);
        expect(readFileSync(fixture.enrollment), checkpoint).toEqual(enrollmentBefore);
        expect(readFileSync(fixture.collectorState), checkpoint).toEqual(stateBefore);
        expect(buildCacheIdentity(join(fixture.support, 'outbox')), checkpoint).toEqual(outboxBefore);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-job')), checkpoint).toBe(true);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-running')), checkpoint).toBe(true);
        const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
        expect(retry.status, `${checkpoint} retry: ${retry.stderr}`).toBe(0);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 120_000);

  it('recovers and retries after actual SIGKILL at every durable migration boundary', () => {
    const boundaries = [
      'journal-ready', 'prepare', 'old-job-stop', 'launcher-directory',
      'releases-directory', 'installation-directory', 'launcher-placement',
      'release-placement', 'state-write', 'plist-replacement', 'shim-replacement',
      'command-link-replacement', 'bootstrap', 'prepared-health', 'stable-plist',
      'acceptance-mark',
    ];
    for (const boundary of boundaries) {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-sigkill-${boundary}-`));
      try {
        const fixture = legacySequenceEightFixture(root, true, 3);
        const appBefore = buildCacheIdentity(fixture.app);
        const enrollmentBefore = readFileSync(fixture.enrollment);
        const stateBefore = readFileSync(fixture.collectorState);
        const outboxBefore = buildCacheIdentity(join(fixture.support, 'outbox'));
        const killed = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          RUNTIME_RAIDERS_TEST_KILL_AFTER: boundary,
        });
        expect(killed.signal, `${boundary}: ${killed.stderr}`).toBe('SIGKILL');

        const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
        expect(retry.status, `${boundary} retry: ${retry.stderr}`).toBe(0);
        expect(buildCacheIdentity(fixture.app), boundary).toEqual(appBefore);
        expect(readFileSync(fixture.enrollment), boundary).toEqual(enrollmentBefore);
        expect(readFileSync(fixture.collectorState), boundary).toEqual(stateBefore);
        expect(buildCacheIdentity(join(fixture.support, 'outbox')), boundary).toEqual(outboxBefore);
        expect(existsSync(join(fixture.support, '.migration-v1')), boundary).toBe(false);
        expect(existsSync(releaseStatePath(fixture.support)), boundary).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 180_000);

  it('uses an atomic journal lifecycle and commits before candidate resume', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-atomic-journal-order-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const log = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(log.indexOf('checkpoint:after-journal-activation')).toBeGreaterThanOrEqual(0);
      expect(log.indexOf('checkpoint:after-commit-marker')).toBeGreaterThan(
        log.indexOf('checkpoint:before-commit-marker'),
      );
      expect(log.indexOf('checkpoint:state-write')).toBeGreaterThan(
        log.indexOf('checkpoint:after-commit-marker'),
      );
      expect(log.indexOf('candidate:__runtime-raiders-installer-resume 1')).toBeGreaterThan(
        log.indexOf('checkpoint:state-write'),
      );
      expect(log.indexOf('checkpoint:accepted-cleanup-after-rename')).toBeGreaterThan(
        log.indexOf('candidate:__runtime-raiders-installer-resume 1'),
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lease abandonment after a precommit kill cannot resume or expose the candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-precommit-abandonment-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_SIMULATE_LEASE_ABANDONMENT: '1',
        RUNTIME_RAIDERS_TEST_KILL_AFTER: 'prepared-health',
      });
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const killedLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(killedLog).toContain('abandonment:fail-closed');
      expect(killedLog).not.toContain('abandonment:resume');
      expect(killedLog).not.toContain('endpoint /api/');
      expect(existsSync(releaseStatePath(fixture.support))).toBe(false);

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr + retry.stdout).toBe(0);
      expect(readFileSync(join(fixture.home, 'commands.log'), 'utf8')).not.toContain('endpoint /api/');
      expect(readFileSync(join(fixture.home, 'binary.log'), 'utf8'))
        .toContain('__runtime-raiders-legacy-resume');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('lease abandonment after the durable state commit converges only to the candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-postcommit-abandonment-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_SIMULATE_LEASE_ABANDONMENT: '1',
        RUNTIME_RAIDERS_TEST_KILL_AFTER: 'state-write',
      });
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const killedLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(killedLog).toContain('abandonment:resume');
      expect(killedLog).not.toContain('__runtime-raiders-legacy-resume');

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr + retry.stdout).toBe(0);
      const finalLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(finalLog).not.toContain('__runtime-raiders-legacy-resume');
      expect(existsSync(releaseStatePath(fixture.support))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it.each([
    'journal-staging-directory',
    'journal-staging-populated',
    'before-journal-activation',
    'after-journal-activation',
    'before-commit-marker',
    'after-commit-marker',
    'state-write',
    'stable-plist',
    'after-candidate-resume',
    'accepted-cleanup-before-rename',
    'accepted-cleanup-after-rename',
    'accepted-cleanup-before-delete',
  ] as const)('re-enters safely after SIGKILL at the %s boundary', (boundary) => {
    const root = mkdtempSync(join(tmpdir(), `runtime-raiders-second-wave-${boundary}-`));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const protectedBefore = buildCacheIdentity(join(fixture.support, 'outbox'));
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_KILL_AFTER: boundary,
      });
      expect(killed.signal, `${boundary}: ${killed.stderr}`).toBe('SIGKILL');

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, `${boundary} retry: ${retry.stderr}`).toBe(0);
      expect(buildCacheIdentity(join(fixture.support, 'outbox'))).toEqual(protectedBefore);
      expect(existsSync(join(fixture.support, '.migration-v1'))).toBe(false);
      expect(existsSync(join(fixture.support, '.migration-v1.staging'))).toBe(false);
      expect(existsSync(join(fixture.support, '.migration-v1.tombstone'))).toBe(false);
      expect(readFileSync(join(fixture.home, 'commands.log'), 'utf8')).not.toContain('endpoint /api/');
      if (['after-commit-marker', 'state-write', 'stable-plist', 'after-candidate-resume',
        'accepted-cleanup-before-rename', 'accepted-cleanup-after-rename',
        'accepted-cleanup-before-delete'].includes(boundary)) {
        expect(readFileSync(join(fixture.home, 'binary.log'), 'utf8'))
          .not.toContain('__runtime-raiders-legacy-resume');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('re-enters after SIGKILL from inside accepted tombstone deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-cleanup-delete-kill-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_KILL_DURING_TOMBSTONE_DELETE: '1',
      });
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      expect(existsSync(join(fixture.support, '.migration-v1.tombstone'))).toBe(true);

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr + retry.stdout).toBe(0);
      expect(existsSync(join(fixture.support, '.migration-v1'))).toBe(false);
      expect(existsSync(join(fixture.support, '.migration-v1.tombstone'))).toBe(false);
      expect(existsSync(join(fixture.support, '.migration-v1.rollback-tombstone'))).toBe(false);
      expect(readFileSync(join(fixture.home, 'binary.log'), 'utf8'))
        .not.toContain('__runtime-raiders-legacy-resume');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it('fails closed without deleting a symlinked active cleanup tombstone residue', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-unsafe-active-tombstone-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_KILL_AFTER: 'accepted-cleanup-before-delete',
      });
      expect(killed.signal).toBe('SIGKILL');
      const tombstone = join(fixture.support, '.migration-v1.tombstone');
      const outside = join(root, 'outside-active-evidence');
      writeFileSync(outside, 'preserve\n');
      symlinkSync(outside, join(tombstone, 'unsafe-link'));

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status).not.toBe(0);
      expect(existsSync(tombstone)).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('preserve\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['staging-cleanup-after-rename', 'staging-cleanup-before-delete'] as const)(
    'retires a stale partial journal after SIGKILL at %s',
    (boundary) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-stale-staging-${boundary}-`));
      try {
        const fixture = legacySequenceEightFixture(root, false, 1);
        const first = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          RUNTIME_RAIDERS_TEST_KILL_AFTER: 'journal-staging-directory',
        });
        expect(first.signal).toBe('SIGKILL');
        const second = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          RUNTIME_RAIDERS_TEST_KILL_AFTER: boundary,
        });
        expect(second.signal, second.stderr).toBe('SIGKILL');
        const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
        expect(retry.status, retry.stderr + retry.stdout).toBe(0);
        expect(existsSync(join(fixture.support, '.migration-v1.staging'))).toBe(false);
        expect(existsSync(join(fixture.support, '.migration-v1.staging-tombstone'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('fails closed without deleting an unsafe stale staging tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-unsafe-stale-staging-'));
    try {
      const fixture = legacySequenceEightFixture(root, false, 1);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_KILL_AFTER: 'journal-staging-directory',
      });
      expect(killed.signal).toBe('SIGKILL');
      const staging = join(fixture.support, '.migration-v1.staging');
      const outside = join(root, 'outside-evidence');
      writeFileSync(outside, 'preserve\n');
      symlinkSync(outside, join(staging, 'unsafe-link'));

      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status).not.toBe(0);
      expect(existsSync(staging)).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('preserve\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('completes the committed candidate after SIGKILL from inside resume', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-kill-during-resume-'));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_KILL_DURING_RESUME: '1',
      });
      expect(killed.signal, killed.stderr).toBe('SIGKILL');
      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr + retry.stdout).toBe(0);
      const log = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(log).not.toContain('__runtime-raiders-legacy-resume');
      expect(log).toContain('candidate:__runtime-raiders-installer-resume 1');
      expect(existsSync(join(fixture.support, '.migration-v1'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it.each([
    'rollback-cleanup-before-rename',
    'rollback-cleanup-after-rename',
    'rollback-cleanup-before-delete',
  ] as const)('retries after SIGKILL during %s', (boundary) => {
    const root = mkdtempSync(join(tmpdir(), `runtime-raiders-rollback-cleanup-${boundary}-`));
    try {
      const fixture = legacySequenceEightFixture(root, true, 3);
      const killed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_FAIL_AFTER: 'bootstrap',
        RUNTIME_RAIDERS_TEST_KILL_AFTER: boundary,
      });
      expect(killed.signal, `${boundary}: ${killed.stderr}`).toBe('SIGKILL');
      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, `${boundary} retry: ${retry.stderr}`).toBe(0);
      expect(existsSync(join(fixture.support, '.migration-v1'))).toBe(false);
      expect(existsSync(join(fixture.support, '.migration-v1.tombstone'))).toBe(false);
      expect(existsSync(join(fixture.support, '.migration-v1.rollback-tombstone'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  it.each(['malformed', 'duplicate-key', 'unsafe-mode', 'tampered-backup', 'symlink'] as const)(
    'fails closed on a %s migration journal without deleting or starting anything',
    (mutation) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-journal-${mutation}-`));
      try {
        const fixture = legacySequenceEightFixture(root, true, 3);
        const killed = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          RUNTIME_RAIDERS_TEST_KILL_AFTER: 'old-job-stop',
        });
        expect(killed.signal).toBe('SIGKILL');
        const migrationDirectory = join(fixture.support, '.migration-v1');
        const journal = join(migrationDirectory, 'journal.json');
        if (mutation === 'malformed') writeFileSync(journal, '{');
        if (mutation === 'duplicate-key') {
          writeFileSync(
            journal,
            readFileSync(journal, 'utf8').replace(
              '"schema_version":1',
              '"schema_version":1,"schema_version":1',
            ),
          );
        }
        if (mutation === 'unsafe-mode') chmodSync(journal, 0o644);
        if (mutation === 'tampered-backup') {
          writeFileSync(join(migrationDirectory, 'old.plist'), 'tampered\n');
        }
        if (mutation === 'symlink') {
          const target = join(root, 'unrelated-journal');
          writeFileSync(target, '{}\n');
          unlinkSync(journal);
          symlinkSync(target, journal);
        }
        writeFileSync(join(fixture.home, 'commands.log'), '');
        const before = buildCacheIdentity(migrationDirectory);
        const refused = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
        expect(refused.status).not.toBe(0);
        expect(buildCacheIdentity(migrationDirectory)).toEqual(before);
        expect(readFileSync(join(fixture.home, 'commands.log'), 'utf8')).not.toContain('launchctl ');
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-job'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('existing protocol two layout refuses reinstall with raiders update before network or code read', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-existing-v2-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root); const environment = env(home, fake, files);
      expect(invoke(renderedProtocolTwoInstaller(root), installerArgs(root), environment).status).toBe(0);
      writeFileSync(join(home, 'commands.log'), '');
      const refused = invoke(renderedProtocolTwoInstaller(root), [], environment);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('raiders update');
      expect(readFileSync(join(home, 'commands.log'), 'utf8')).toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('new enrollment survives a failed fresh transaction and makes retry code-free', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-new-enrollment-retry-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root); const environment = env(home, fake, files);
      const failed = invoke(renderedProtocolTwoInstaller(root), installerArgs(root), {
        ...environment,
        RUNTIME_RAIDERS_TEST_FAIL_AFTER: 'bootstrap',
      });
      expect(failed.status).not.toBe(0);
      const enrollment = join(home, 'Library/Application Support/Runtime Raiders/state/enrollment.json');
      expect(existsSync(enrollment)).toBe(true);
      const before = readFileSync(enrollment);
      expect(invoke(renderedProtocolTwoInstaller(root), [], environment).status).toBe(0);
      expect(readFileSync(enrollment)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps the enrollment code out of process arguments at the canonical execution boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-code-file-v2-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const script = renderedProtocolTwoInstaller(root);
      const code = oneTimeCodeFile(root);
      const environment = env(home, fake, files);
      const result = spawnSync('/bin/sh', [script, '--code-file', code], {
        env: environment,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const log = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(log).not.toContain(enrollmentCode);
      expect(log).not.toContain('banned ');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fully verifies the archive before spending a new enrollment code', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-trust-before-enroll-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const environment = { ...env(home, fake, files), FAKE_SHASUM_FAIL: '1' };
      const result = invoke(renderedProtocolTwoInstaller(root), installerArgs(root), environment);
      expect(result.status).not.toBe(0);
      const log = readFileSync(join(home, 'commands.log'), 'utf8');
      expect(log).not.toContain('/api/raiders/enroll');
      expect(log).not.toContain(enrollmentCode);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['archive', 'extracted'] as const)(
    'runs the embedded production validator at the %s boundary before enrollment',
    (phase) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-installer-validator-${phase}-`));
      try {
        const home = join(root, 'home'); mkdirSync(home);
        const fake = fakes(root); const files = protocolTwoArtifact(root);
        const result = invoke(renderedProtocolTwoInstaller(root), installerArgs(root), {
          ...env(home, fake, files),
          FAKE_INSTALLER_VALIDATOR_FAIL: phase,
        });
        expect(result.status).not.toBe(0);
        const lines = readFileSync(join(home, 'commands.log'), 'utf8').trim().split('\n');
        const archiveValidation = lines.findIndex((line) => line.startsWith('installer-validator ') &&
          line.includes('runtime-raiders-agent.zip') && !line.includes('/unpacked '));
        const extraction = lines.findIndex((line) => line.startsWith('ditto -x -k '));
        if (phase === 'archive') {
          expect(archiveValidation).toBeGreaterThanOrEqual(0);
          expect(extraction).toBe(-1);
        } else {
          const extractedValidation = lines.findIndex((line) => line.startsWith('installer-validator ') &&
            line.includes('/unpacked '));
          expect(archiveValidation).toBeGreaterThanOrEqual(0);
          expect(extraction).toBeGreaterThan(archiveValidation);
          expect(extractedValidation).toBeGreaterThan(extraction);
        }
        expect(lines.some((line) => line.includes('/api/raiders/enroll'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it.each([
    ['bootout stopped then failed', { FAKE_BOOTOUT_STOPS_THEN_FAIL: '1' }],
    ['bootstrap started then failed', { FAKE_BOOTSTRAP_STARTS_THEN_FAIL: '1' }],
    ['command link changed then failed', { FAKE_LN_MUTATES_THEN_FAIL: '1' }],
  ] as const)('reconciles ambiguous %s and restores a healthy legacy daemon', (_name, injected) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-ambiguous-rollback-'));
    try {
      const fixture = legacySequenceEightFixture(root, true);
      const plistBefore = readFileSync(fixture.plist);
      const shimBefore = readFileSync(fixture.shim);
      const failed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        ...injected,
      });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(fixture.plist)).toEqual(plistBefore);
      expect(readFileSync(fixture.shim)).toEqual(shimBefore);
      expect(readlinkSync(fixture.commandPath)).toBe(fixture.shim);
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-job'))).toBe(true);
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-running'))).toBe(true);
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-prepared'))).toBe(false);
      const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(retry.status, retry.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['candidate-prepared', 'candidate-resumed'] as const)(
    'rejects protected state mutation at %s without crossing the commit boundary backward',
    (phase) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-protected-${phase}-`));
      try {
        const fixture = legacySequenceEightFixture(root, false);
        const failed = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          FAKE_MUTATE_PROTECTED_AT: phase,
        });
        expect(failed.status).not.toBe(0);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-running')))
          .toBe(phase === 'candidate-resumed');
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-job')))
          .toBe(phase === 'candidate-resumed');
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-prepared')))
          .toBe(phase === 'candidate-prepared');
        if (phase === 'candidate-resumed') {
          expect(existsSync(join(fixture.support, '.migration-v1'))).toBe(true);
          expect(existsSync(releaseStatePath(fixture.support))).toBe(true);
          expect(readFileSync(join(fixture.home, 'binary.log'), 'utf8'))
            .not.toContain('__runtime-raiders-legacy-resume');
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it('refuses status from a daemon peer other than the exact admitted executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-peer-mismatch-'));
    try {
      const fixture = legacySequenceEightFixture(root, true);
      const failed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_STATUS_PEER_MISMATCH: 'legacy-running',
      });
      expect(failed.status).not.toBe(0);
      const binaryLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(binaryLog).not.toContain('__runtime-raiders-legacy-prepare');
      expect(readFileSync(fixture.collectorState, 'utf8')).toContain('"enabled":true');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps rollback stopped without resuming collection when protected topology mutates', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-rollback-protected-'));
    try {
      const fixture = legacySequenceEightFixture(root, true);
      const failed = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        RUNTIME_RAIDERS_TEST_FAIL_AFTER: 'bootstrap',
        FAKE_MUTATE_PROTECTED_DURING_ROLLBACK: '1',
      });
      expect(failed.status).not.toBe(0);
      expect(readFileSync(fixture.collectorState, 'utf8')).toContain('"enabled":true');
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-prepared'))).toBe(true);
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-job'))).toBe(false);
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-running'))).toBe(false);
      const binaryLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(binaryLog).not.toContain('__runtime-raiders-legacy-resume');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects any flat release other than exact protocol-one sequence eight before mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-wrong-legacy-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const info = join(fixture.app, 'Contents/Info.plist');
      writeFileSync(info, readFileSync(info, 'utf8').replace(
        '<key>RuntimeRaidersReleaseSequence</key><integer>8</integer>',
        '<key>RuntimeRaidersReleaseSequence</key><integer>7</integer>',
      ));
      const before = buildCacheIdentity(fixture.app);
      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('only protocol-1 sequence 8');
      expect(buildCacheIdentity(fixture.app)).toEqual(before);
      const commandLog = join(fixture.home, 'commands.log');
      expect(existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '').toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a sequence-eight bundle whose embedded release SHA is not the published canary SHA', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-wrong-legacy-sha-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const info = join(fixture.app, 'Contents/Info.plist');
      writeFileSync(info, readFileSync(info, 'utf8').replace(legacyReleaseSHA, '8'.repeat(40)));
      const before = buildCacheIdentity(fixture.app);
      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('only protocol-1 sequence 8');
      expect(buildCacheIdentity(fixture.app)).toEqual(before);
      const commandLog = join(fixture.home, 'commands.log');
      expect(existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '').toBe('');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a sequence-eight LaunchAgent that does not launch the exact flat daemon', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-wrong-legacy-plist-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      writeFileSync(fixture.plist, readFileSync(fixture.plist, 'utf8').replace(
        `<string>${fixture.executable}</string>`,
        '<string>/tmp/not-the-flat-agent</string>',
      ));
      const appBefore = buildCacheIdentity(fixture.app);
      const plistBefore = readFileSync(fixture.plist);
      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('complete sequence-8 installation');
      expect(buildCacheIdentity(fixture.app)).toEqual(appBefore);
      expect(readFileSync(fixture.plist)).toEqual(plistBefore);
      const commandLog = join(fixture.home, 'commands.log');
      const commands = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
      expect(commands).not.toContain('curl ');
      expect(commands).not.toContain('launchctl ');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an owner-only alternate command path without mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-alternate-legacy-command-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const alternateDirectory = join(fixture.home, 'bin');
      const alternate = join(alternateDirectory, 'raiders');
      mkdirSync(alternateDirectory, { mode: 0o700 });
      unlinkSync(fixture.commandPath);
      symlinkSync(fixture.shim, alternate);
      writeFileSync(join(fixture.support, 'state/command-link'), alternate + '\n');
      chmodSync(join(fixture.support, 'state/command-link'), 0o600);
      const environment = {
        ...fixture.environment,
        PATH: alternateDirectory + ':' + fixture.environment.PATH,
      };
      const appBefore = buildCacheIdentity(fixture.app);
      const failed = invoke(renderedProtocolTwoInstaller(root), [], environment);
      expect(failed.status).not.toBe(0);
      expect(readFileSync(join(fixture.support, 'state/command-link'), 'utf8')).toBe(alternate + '\n');
      expect(readlinkSync(alternate)).toBe(fixture.shim);
      expect(existsSync(fixture.commandPath)).toBe(false);
      expect(buildCacheIdentity(fixture.app)).toEqual(appBefore);
      const commands = readFileSync(join(fixture.home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('curl ');
      expect(commands).not.toContain('launchctl ');
      expect(existsSync(join(fixture.home, '.local/bin/raiders'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a pre-existing canonical command even when it targets the legacy shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-duplicate-command-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const canonical = join(fixture.home, '.local/bin/raiders');
      mkdirSync(join(canonical, '..'), { recursive: true, mode: 0o700 });
      symlinkSync(fixture.shim, canonical);
      const legacyBefore = readlinkSync(fixture.commandPath);
      const recordBefore = readFileSync(join(fixture.support, 'state/command-link'));

      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);

      expect(result.status).not.toBe(0);
      expect(readlinkSync(fixture.commandPath)).toBe(legacyBefore);
      expect(readlinkSync(canonical)).toBe(fixture.shim);
      expect(readFileSync(join(fixture.support, 'state/command-link'))).toEqual(recordBefore);
      const commandLog = join(fixture.home, 'commands.log');
      const commands = existsSync(commandLog) ? readFileSync(commandLog, 'utf8') : '';
      expect(commands).not.toContain('curl ');
      expect(commands).not.toContain('launchctl ');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects an external command path other than the exact canary leaf before download', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-unbound-command-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const outsideDirectory = join(root, 'outside-command');
      const outsideCommand = join(outsideDirectory, 'raiders');
      mkdirSync(outsideDirectory, { mode: 0o700 });
      unlinkSync(fixture.commandPath);
      symlinkSync(fixture.shim, outsideCommand);
      writeFileSync(join(fixture.support, 'state/command-link'), outsideCommand + '\n', { mode: 0o600 });

      const result = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        PATH: outsideDirectory + ':' + fixture.environment.PATH,
      });
      expect(result.status).not.toBe(0);
      const commands = readFileSync(join(fixture.home, 'commands.log'), 'utf8');
      expect(commands).not.toContain('curl ');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses migration while a Run is active without preparing or stopping the old daemon', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-active-run-'));
    try {
      const fixture = legacySequenceEightFixture(root, true);
      const result = invoke(renderedProtocolTwoInstaller(root), [], {
        ...fixture.environment,
        FAKE_ACTIVE_RUN_COUNT: '1',
      });
      expect(result.status).not.toBe(0);
      const binaryLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(binaryLog).not.toContain('__runtime-raiders-legacy-prepare');
      expect(readFileSync(join(fixture.home, 'commands.log'), 'utf8')).not.toContain('launchctl bootout');
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-running'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses symlinked owned paths and command conflicts before network access', () => {
    for (const kind of ['symlink', 'conflict'] as const) {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-preflight-${kind}-`));
      try {
        const home = join(root, 'home'); mkdirSync(home);
        const fake = fakes(root); const files = protocolTwoArtifact(root);
        const commandDir = join(home, 'bin'); mkdirSync(commandDir);
        if (kind === 'symlink') {
          const target = join(root, 'unrelated'); mkdirSync(target);
          mkdirSync(join(home, 'Library'), { recursive: true });
          symlinkSync(target, join(home, 'Library/Application Support'));
        } else {
          const canonicalBin = join(home, '.local/bin');
          mkdirSync(canonicalBin, { recursive: true });
          writeFileSync(join(canonicalBin, 'raiders'), 'user command\n');
        }
        const result = invoke(
          renderedProtocolTwoInstaller(root),
          installerArgs(root),
          env(home, fake, files, commandDir),
        );
        expect(result.status).not.toBe(0);
        expect(existsSync(join(home, 'commands.log')) ? readFileSync(join(home, 'commands.log'), 'utf8') : '').toBe('');
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('stable launcher shim uninstalls only its owned protocol-two surfaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-uninstall-v2-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const commandDir = join(home, 'bin'); mkdirSync(commandDir);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const environment = env(home, fake, files, commandDir);
      expect(invoke(renderedProtocolTwoInstaller(root), installerArgs(root), environment).status).toBe(0);
      const command = join(home, '.local/bin/raiders');
      const uninstall = spawnSync(command, ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders'))).toBe(false);
      expect(existsSync(command)).toBe(false);
      expect(existsSync(join(home, 'Library/LaunchAgents', `${label}.plist`))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Runtime Raiders release build', () => {
  it('makes the validator builder own and remove an initially absent scratch path', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-validator-scratch-'));
    try {
      const fake = join(root, 'fakes');
      const outputParent = join(root, 'output');
      const scratch = join(root, 'validator-scratch');
      const output = join(outputParent, 'runtime-raiders-release-validator');
      mkdirSync(fake);
      mkdirSync(outputParent);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      const fixture = disposableReleaseBuilder(root);

      const result = invoke(
        fixture.releaseValidatorBuild,
        [join(fixture.repository, 'companion'), scratch, output],
        { ...process.env, PATH: `${fake}:/usr/bin:/bin` },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(existsSync(scratch)).toBe(false);
      expect(lstatSync(output).isFile()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes validator scratch and incomplete output after failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-validator-failure-'));
    try {
      const fake = join(root, 'fakes');
      const outputParent = join(root, 'output');
      const scratch = join(root, 'validator-scratch');
      const output = join(outputParent, 'runtime-raiders-release-validator');
      mkdirSync(fake);
      mkdirSync(outputParent);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      const fixture = disposableReleaseBuilder(root);

      const result = invoke(
        fixture.releaseValidatorBuild,
        [join(fixture.repository, 'companion'), scratch, output],
        {
          ...process.env,
          PATH: `${fake}:/usr/bin:/bin`,
          FAKE_LIPO_VERIFY_FAIL_TARGET: 'runtime-raiders-release-validator',
        },
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes validator scratch after interruption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-validator-interrupt-'));
    try {
      const fake = join(root, 'fakes');
      const outputParent = join(root, 'output');
      const scratch = join(root, 'validator-scratch');
      const output = join(outputParent, 'runtime-raiders-release-validator');
      const ready = join(root, 'swift-ready');
      mkdirSync(fake);
      mkdirSync(outputParent);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      const fixture = disposableReleaseBuilder(root);

      const result = await interruptProcessGroup(
        fixture.releaseValidatorBuild,
        [join(fixture.repository, 'companion'), scratch, output],
        {
          ...process.env,
          PATH: `${fake}:/usr/bin:/bin`,
          RUNTIME_RAIDERS_TEST_SWIFT_READY: ready,
        },
        ready,
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a validator scratch path through a symlinked parent without mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-validator-escape-'));
    try {
      const fake = join(root, 'fakes');
      const outputParent = join(root, 'output');
      const external = join(root, 'external');
      const alias = join(root, 'alias');
      const scratch = join(alias, 'validator-scratch');
      const output = join(outputParent, 'runtime-raiders-release-validator');
      mkdirSync(fake);
      mkdirSync(outputParent);
      mkdirSync(external);
      writeFileSync(join(external, 'sentinel'), 'preserve');
      symlinkSync(external, alias);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      const fixture = disposableReleaseBuilder(root);

      const result = invoke(
        fixture.releaseValidatorBuild,
        [join(fixture.repository, 'companion'), scratch, output],
        { ...process.env, PATH: `${fake}:/usr/bin:/bin` },
      );

      expect(result.status).toBe(64);
      expect(readdirSync(external)).toEqual(['sentinel']);
      expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('preserve');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a private default scratch and leaves the source repository clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-default-scratch-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output),
        {
          ...process.env,
          PATH: `${fake}:/usr/bin:/bin`,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(fixture.repository, 'companion/.build'))).toBe(false);
      expect(execFileSync('/usr/bin/git', [
        'status', '--porcelain', '--untracked-files=all',
      ], { cwd: fixture.repository, encoding: 'utf8' })).toBe('');
      expect(readdirSync(output).sort()).toEqual([
        'install.sh',
        'runtime-raiders-agent.update.json',
        'runtime-raiders-agent.zip',
        'runtime-raiders-agent.zip.sha256',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes explicit agent scratch after failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-agent-failure-'));
    try {
      const fake = join(root, 'fakes');
      const scratch = join(root, 'scratch');
      mkdirSync(fake);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root, { rendererFailure: true });
      const output = immutableReleaseOutput(root, fixture);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', scratch),
        {
          ...process.env,
          PATH: `${fake}:/usr/bin:/bin`,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).toBe(89);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing scratch path without deleting caller contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-existing-scratch-'));
    try {
      const scratch = join(root, 'scratch');
      mkdirSync(scratch);
      writeFileSync(join(scratch, 'sentinel'), 'caller-owned');
      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', scratch),
        {
          ...process.env,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).toBe(64);
      expect(readdirSync(scratch)).toEqual(['sentinel']);
      expect(readFileSync(join(scratch, 'sentinel'), 'utf8')).toBe('caller-owned');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes explicit agent scratch after interruption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-agent-interrupt-'));
    try {
      const fake = join(root, 'fakes');
      const scratch = join(root, 'scratch');
      const ready = join(root, 'swift-ready');
      mkdirSync(fake);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);

      const result = await interruptProcessGroup(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', scratch),
        {
          ...process.env,
          PATH: `${fake}:/usr/bin:/bin`,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
          RUNTIME_RAIDERS_TEST_SWIFT_READY: ready,
        },
        ready,
      );

      expect(result.status).not.toBe(0);
      expect(existsSync(scratch)).toBe(false);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects agent scratch through a symlinked parent without mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-agent-escape-'));
    try {
      const fake = join(root, 'fakes');
      const external = join(root, 'external');
      const alias = join(root, 'alias');
      const scratch = join(alias, 'scratch');
      mkdirSync(fake);
      mkdirSync(external);
      writeFileSync(join(external, 'sentinel'), 'preserve');
      symlinkSync(external, alias);
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      const fixture = disposableReleaseBuilder(root, { rendererFailure: true });
      const output = immutableReleaseOutput(root, fixture);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', scratch),
        {
          ...process.env,
          PATH: `${fake}:/usr/bin:/bin`,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).toBe(64);
      expect(readdirSync(external)).toEqual(['sentinel']);
      expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('preserve');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires an explicit immutable output directory instead of generic dist evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-explicit-output-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root);
      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).toBe(64);
      expect(result.stderr).toContain('--output is required');
      expect(existsSync(join(fixture.repository, 'dist'))).toBe(false);

      const generic = invoke(
        fixture.build,
        releaseBuildArgs(
          fixture.releaseSHA,
          '--output', join(root, 'generic-output'),
          '--scratch-path', join(root, 'generic-scratch'),
        ),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );
      expect(generic.status).toBe(64);
      expect(generic.stderr).toContain('output directory must encode the release identity');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the reviewed deterministic renderer for the emitted installer', () => {
    // Catches the release builder returning to an independent ad-hoc rendering path.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-shared-renderer-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root, { rendererFailure: true });
      const output = immutableReleaseOutput(root, fixture);
      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );
      expect(result.status, result.stderr).toBe(89);
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a rendered installer above the public 8 MiB bound before emitting a quartet', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-installer-bound-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root, { oversizedRenderer: true });
      const output = immutableReleaseOutput(root, fixture);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).not.toBe(0);
      expect(
        result.stderr,
        JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout }),
      ).toContain('rendered installer exceeds public size limit');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the shared artifact contract instead of a private installer-size literal', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-shared-installer-bound-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root, { installerMaxBytes: 8 });
      const output = immutableReleaseOutput(root, fixture);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('rendered installer exceeds public size limit');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('points the launchd template only at the stable launcher and literal daemon command', () => {
    const template = readFileSync(join(
      process.cwd(),
      'companion/packaging/com.redlattice.runtime-raiders-agent.plist.template',
    ), 'utf8');
    expect(template).toContain('<string>__RUNTIME_RAIDERS_LAUNCHER_EXECUTABLE__</string>');
    expect(template).toContain('<string>daemon</string>');
    expect(template).not.toContain('Runtime Raiders Agent.app');
    expect(template).not.toContain('/releases/');
  });

  it('seals the exact reviewed release identity into the app before signing', () => {
    // Catches a signed bundle whose runtime identity cannot pass CompanionReleaseIdentity parsing.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-sealed-release-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const capturedAgentPlist = join(root, 'Agent-Info.plist');
      const capturedLauncherPlist = join(root, 'Launcher-Info.plist');
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), [
        'signing=0; last=""',
        'for argument in "$@"; do [ "$argument" = --force ] && signing=1; last="$argument"; done',
        '[ "$signing" = 0 ] || {',
        '  /usr/bin/plutil -lint "$last/Contents/Info.plist" >/dev/null',
        '  case "$last" in',
        '    *"Runtime Raiders Agent.app") /bin/cp "$last/Contents/Info.plist" "$RUNTIME_RAIDERS_TEST_AGENT_PLIST";;',
        '    *"Runtime Raiders Launcher.app") /bin/cp "$last/Contents/Info.plist" "$RUNTIME_RAIDERS_TEST_LAUNCHER_PLIST";;',
        '    *) exit 64;;',
        '  esac',
        '}',
      ]);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);

      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);
      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', output, '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_TEST_AGENT_PLIST: capturedAgentPlist,
          RUNTIME_RAIDERS_TEST_LAUNCHER_PLIST: capturedLauncherPlist,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const value = (plist: string, key: string) => execFileSync(
        '/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' },
      ).trim();
      expect(value(capturedAgentPlist, 'CFBundleIdentifier')).toBe('com.redlattice.runtime-raiders-agent');
      expect(value(capturedAgentPlist, 'CFBundleExecutable')).toBe('runtime-raiders-agent');
      expect(value(capturedAgentPlist, 'CFBundleShortVersionString')).toBe(companionVersion);
      expect(value(capturedAgentPlist, 'RuntimeRaidersReleaseSequence')).toBe(releaseSequence);
      expect(value(capturedAgentPlist, 'RuntimeRaidersReleaseSHA')).toBe(fixture.releaseSHA);
      expect(value(capturedAgentPlist, 'RuntimeRaidersUpdateProtocolVersion')).toBe(packagedUpdateProtocolVersion);
      expect(value(capturedLauncherPlist, 'CFBundleIdentifier')).toBe('com.redlattice.runtime-raiders-launcher');
      expect(value(capturedLauncherPlist, 'CFBundleExecutable')).toBe('runtime-raiders-launcher');
      expect(value(capturedLauncherPlist, 'RuntimeRaidersLauncherProtocolVersion')).toBe('1');
      expect(() => value(capturedLauncherPlist, 'RuntimeRaidersReleaseSequence')).toThrow();
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
        ['missing newline', 'version=1\ncompanion_version=0.3.0\nrelease_sequence=9\nupdate_protocol_version=2', 'companion/RELEASE is invalid'],
        ['extra line', 'version=1\ncompanion_version=0.3.0\nrelease_sequence=9\nupdate_protocol_version=2\nextra=1\n', 'companion/RELEASE is invalid'],
        ['unsafe version', 'version=1\ncompanion_version=0.3.0</string>\nrelease_sequence=9\nupdate_protocol_version=2\n', 'companion_version is invalid'],
        ['zero sequence', 'version=1\ncompanion_version=0.3.0\nrelease_sequence=0\nupdate_protocol_version=2\n', 'release_sequence is invalid'],
        ['unsafe sequence', 'version=1\ncompanion_version=0.3.0\nrelease_sequence=9007199254740992\nupdate_protocol_version=2\n', 'release_sequence is invalid'],
        ['unsupported protocol', 'version=1\ncompanion_version=0.3.0\nrelease_sequence=9\nupdate_protocol_version=1\n', 'update_protocol_version is invalid'],
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
        if (state === 'dirty tracked') writeFileSync(
          join(fixture.repository, 'scripts/release/runtime-raiders-macho-uuid.c'),
          'int deliberately_dirty_for_release_test;\n',
        );
        if (state === 'dirty untracked') writeFileSync(join(fixture.repository, 'untracked-release-note'), 'dirty\n');
        const output = join(
          root,
          `sequence-${releaseSequence}-${requestedSHA}`,
        );

        const result = invoke(
          fixture.build,
          releaseBuildArgs(requestedSHA, '--output', output, '--scratch-path', join(root, 'scratch')),
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

  it('resolves, owns, and removes a relative scratch path against the caller', () => {
    // Catches resolving one scratch argument from two different working directories or retaining it.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-relative-scratch-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const scratchLog = join(root, 'scratch.log');
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);
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
          RUNTIME_RAIDERS_TEST_SWIFT_SCRATCH_LOG: scratchLog,
        },
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(scratchLog, 'utf8').trim().split('\n').filter(
        (path) => path === join(realpathSync(root), 'relative-scratch'),
      )).toHaveLength(4);
      expect(existsSync(join(root, 'relative-scratch'))).toBe(false);
      expect(existsSync(join(root, 'companion/relative-scratch'))).toBe(false);
      expect(existsSync(join(output, 'runtime-raiders-agent.zip'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed unless both final executables verify as arm64 and x86_64', () => {
    for (const binary of ['runtime-raiders-agent', 'runtime-raiders-launcher']) {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-universal-${binary}-`));
      try {
        const fake = join(root, 'fakes');
        mkdirSync(fake, { recursive: true });
        fakeReleaseSwift(fake);
        fakeReleaseLipo(fake);
        executable(join(fake, 'codesign'), ['exit 0']);
        executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
        executable(join(fake, 'xcrun'), ['exit 0']);
        executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
        const fixture = disposableReleaseBuilder(root);
        const output = immutableReleaseOutput(root, fixture);

        const result = invoke(
          fixture.build,
          releaseBuildArgs(
            fixture.releaseSHA,
            '--output', output,
            '--scratch-path', join(root, 'scratch'),
          ),
          {
            ...process.env,
            PATH: fake + ':/usr/bin:/bin',
            FAKE_LIPO_VERIFY_FAIL_TARGET: binary,
            RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
            RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
            RUNTIME_RAIDERS_TEAM_ID: teamId,
          },
        );

        expect(result.status, binary).not.toBe(0);
        expect(existsSync(output), binary).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  for (const product of ['agent', 'launcher'] as const) {
    it(`rejects a cross-wired ${product} product slice even when both architectures match`, () => {
      // Catches a universal executable assembled from one slice of the other product.
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-cross-wired-${product}-`));
      try {
        const fake = join(root, 'fakes');
        mkdirSync(fake, { recursive: true });
        fakeReleaseSwift(fake);
        fakeReleaseLipo(fake);
        executable(join(fake, 'codesign'), ['exit 0']);
        executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
        executable(join(fake, 'xcrun'), ['exit 0']);
        executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
        const fixture = disposableReleaseBuilder(root, { crossWireArm64Slice: product });
        const output = immutableReleaseOutput(root, fixture);

        const result = invoke(
          fixture.build,
          releaseBuildArgs(
            fixture.releaseSHA,
            '--output', output,
            '--scratch-path', join(root, 'scratch'),
          ),
          {
            ...process.env,
            PATH: fake + ':/usr/bin:/bin',
            RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
            RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
            RUNTIME_RAIDERS_TEAM_ID: teamId,
          },
        );

        expect(result.status).not.toBe(0);
        expect(existsSync(output)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('creates, extracts, and revalidates the notarized ditto archive before emitting a quartet', () => {
    // Catches final packaging that drops macOS signature metadata or trusts only the pre-archive app.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-flow-'));
    try {
      const builderContents = readFileSync(build, 'utf8');
      expect(builderContents).toContain(
        '/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$RELEASE_CONTAINER" "$STAGED_OUTPUT/runtime-raiders-agent.zip"',
      );
      expect(builderContents).toContain(
        '/usr/bin/ditto -x -k "$STAGED_OUTPUT/runtime-raiders-agent.zip" "$ARCHIVE_VALIDATION"',
      );
      expect(builderContents).not.toContain('/usr/bin/zip');

      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const log = join(root, 'commands.log');
      fakeReleaseSwift(fake, true);
      fakeReleaseLipo(fake, true);
      executable(join(fake, 'codesign'), [
        'printf "codesign %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'verify=0; requirement=""; last=""',
        'for argument in "$@"; do [ "$argument" = "--verify" ] && verify=1; [ "$argument" = "-R" ] && exit 65; case "$argument" in -R=*) requirement="$argument";; esac; last="$argument"; done',
        'if [ "$verify" = 1 ]; then',
        '  case "$last" in',
        '    *"Runtime Raiders Agent.app") printf "%s\\n" "$requirement" | grep -F "identifier \\"com.redlattice.runtime-raiders-agent\\"" >/dev/null;;',
        '    *"Runtime Raiders Launcher.app") printf "%s\\n" "$requirement" | grep -F "identifier \\"com.redlattice.runtime-raiders-launcher\\"" >/dev/null;;',
        '    *) exit 65;;',
        '  esac',
        'fi',
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
      const scratch = join(root, 'scratch');
      const releaseValidator = productionReleaseValidator(root);
      const loggingReleaseValidator = join(root, 'logging-release-validator');
      executable(loggingReleaseValidator, [
        'printf "release-validator %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'if [ "$#" -eq 1 ]; then exec "$RUNTIME_RAIDERS_TEST_PRODUCTION_RELEASE_VALIDATOR" "$@"; fi',
        '[ "$#" -eq 7 ]',
      ]);
      const fixture = disposableReleaseBuilder(root, { interceptAbsoluteDitto: true });
      const output = immutableReleaseOutput(root, fixture);
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
      expect(result.stdout).toContain('Built unpublished signed quartet');
      expect(buildCacheIdentity(join(process.cwd(), 'companion/.build'))).toEqual(repositoryCacheBefore);
      expect(existsSync(scratch)).toBe(false);
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
        update_protocol_version: 2,
        zip_sha256: zipDigest,
        zip_url: 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
      }) + '\n');
      const rendered = readFileSync(join(output, 'install.sh'), 'utf8');
      expect(rendered).toContain("TEAM_ID='" + teamId + "'");
      expect(rendered).toContain("VERSION='" + companionVersion + "'");
      expect(rendered).toContain("RELEASE_SEQUENCE='" + releaseSequence + "'");
      expect(rendered).toContain("RELEASE_SHA='" + fixture.releaseSHA + "'");
      expect(rendered).toContain("UPDATE_PROTOCOL_VERSION='" + packagedUpdateProtocolVersion + "'");
      const embeddedValidatorSHA = rendered.match(/^RELEASE_VALIDATOR_SHA256='([0-9a-f]{64})'$/m)?.[1];
      const embeddedValidatorPayload = rendered.match(/^RELEASE_VALIDATOR_BASE64='([A-Za-z0-9+/=]+)'$/m)?.[1];
      expect(embeddedValidatorSHA).toBeDefined();
      expect(embeddedValidatorPayload).toBeDefined();
      expect(createHash('sha256').update(Buffer.from(embeddedValidatorPayload!, 'base64')).digest('hex'))
        .toBe(embeddedValidatorSHA);
      expect(rendered).toContain("ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'");
      expect(rendered).toContain("CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'");
      expect(rendered).not.toContain('__RUNTIME_RAIDERS_');
      const zipEntries = execFileSync('/usr/bin/unzip', ['-Z1', zipPath], { encoding: 'utf8' })
        .trim().split('\n');
      expect(new Set(zipEntries.map((entry) => entry.split('/')[0]))).toEqual(new Set(['Runtime Raiders Release']));
      expect(zipEntries).toContain('Runtime Raiders Release/Runtime Raiders Agent.app/');
      expect(zipEntries).toContain('Runtime Raiders Release/Runtime Raiders Launcher.app/');
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
      expect(commandLines.filter((line) => line.startsWith('lipo -create '))).toHaveLength(3);
      expect(commandLines.filter((line) => line.includes(' -verify_arch arm64 x86_64'))).toHaveLength(3);
      expect(commandLines.filter((line) => line.match(/^swift (arm64|x86_64) runtime-raiders-release-validator$/)))
        .toHaveLength(2);
      expect(commandLines.filter((line) => line.startsWith('codesign --force '))).toHaveLength(2);
      const dittoCommands = commandLines.filter((line) => line.startsWith('ditto '));
      expect(dittoCommands).toHaveLength(3);
      expect(dittoCommands.filter((line) => line.includes('-c -k --sequesterRsrc --keepParent'))).toHaveLength(2);
      expect(dittoCommands.filter((line) => line.startsWith('ditto -x -k '))).toHaveLength(1);
      expect(commandLines.filter((line) => line.startsWith('xcrun notarytool submit '))).toHaveLength(1);
      expect(commandLines.filter((line) => line.startsWith('xcrun stapler staple '))).toHaveLength(2);
      expect(commandLines.filter((line) => line.startsWith('codesign --verify '))).toHaveLength(6);
      expect(commandLines.filter((line) => line.startsWith('xcrun stapler validate '))).toHaveLength(4);

      const notaryCreate = commandLines.findIndex((line) =>
        line.startsWith('ditto -c -k --sequesterRsrc --keepParent ') && line.endsWith('/notary.zip'));
      const notarySubmit = commandLines.findIndex((line) => line.startsWith('xcrun notarytool submit '));
      const staples = commandLines
        .map((line, index) => line.startsWith('xcrun stapler staple ') ? index : -1)
        .filter((index) => index >= 0);
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
        ...staples,
        finalCreate,
        extract,
        extractedCodesign,
        extractedStapler,
        archiveValidator,
        checksum,
      ].every((index) => index >= 0)).toBe(true);
      expect(notaryCreate).toBeLessThan(notarySubmit);
      expect(notarySubmit).toBeLessThan(staples[0]);
      expect(staples[1]).toBeLessThan(finalCreate);
      expect(finalCreate).toBeLessThan(extract);
      expect(extract).toBeLessThan(extractedCodesign);
      expect(extractedCodesign).toBeLessThan(extractedStapler);
      expect(extractedStapler).toBeLessThan(archiveValidator);
      expect(archiveValidator).toBeLessThan(checksum);
      expect(commandLines[archiveValidator]).toContain('/archive-validation.');
      expect(zipFacts).toContain('extended local header:                          yes');
      expect(commands).not.toMatch(/upload|publish|aws|s3|rsync|scp/i);
      const publicationHelper = readFileSync(
        join(process.cwd(), 'scripts/pi/runtime-raiders-artifacts.sh'),
        'utf8',
      );
      expect(builderContents).not.toContain('/var/lib/runtime-raiders/current');
      expect(publicationHelper).toContain('CURRENT=$ARTIFACT_ROOT/current');
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
      fakeReleaseLipo(fake);
      executable(join(fake, 'ditto'), [
        'printf "ditto %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'if [ "$1" = -x ]; then',
        '  /usr/bin/ditto "$@"',
        '  : > "$4/Runtime Raiders Release/Runtime Raiders Agent.app/Contents/.post-extraction"',
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

      const firstOutput = immutableReleaseOutput(root, fixture, 'first-output');
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
      expect(firstVerifications).toHaveLength(5);
      expect(firstVerifications[0]).not.toContain('/archive-validation.');
      expect(firstVerifications[1]).not.toContain('/archive-validation.');
      expect(firstVerifications[2]).not.toContain('/archive-validation.');
      expect(firstVerifications[3]).not.toContain('/archive-validation.');
      expect(firstVerifications[4]).toContain('/archive-validation.');
      expect(firstCommands.filter((line) => line.startsWith('xcrun notarytool submit '))).toHaveLength(1);

      writeFileSync(log, '');
      const existingOutput = immutableReleaseOutput(root, fixture, 'existing-output');
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
      expect(replacement.stderr).toContain('release output must be absent');
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
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), [
        'if [ "$1" = stapler ] && [ "$2" = staple ]; then chmod 0777 "$3/Contents"; fi',
      ]);
      executable(join(fake, 'shasum'), ['exec /usr/bin/shasum "$@"']);
      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);

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

  it('refuses a partial existing output without touching any of its bytes', () => {
    // Catches a local builder treating an unpublished partial directory as replaceable output.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-rollback-'));
    try {
      const fake = join(root, 'fakes');
      mkdirSync(fake, { recursive: true });
      const log = join(root, 'commands.log');
      fakeReleaseSwift(fake);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['exit 1']);
      const fixture = disposableReleaseBuilder(root);
      const output = immutableReleaseOutput(root, fixture);
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
      expect(result.stderr).toContain('release output must be absent');
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip'), 'utf8')).toBe('old zip');
      expect(readFileSync(join(output, 'runtime-raiders-agent.zip.sha256'), 'utf8')).toBe('old checksum');
      expect(readFileSync(join(output, 'install.sh'), 'utf8')).toBe('old installer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a complete existing quartet byte-for-byte instead of replacing it', () => {
    // Public visibility belongs to the immutable-generation selector, not this local builder.
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-release-output-transaction-'));
    try {
      const fake = join(root, 'fakes');
      const buildLog = join(root, 'build.log');
      mkdirSync(fake, { recursive: true });
      fakeReleaseSwift(fake, true);
      fakeReleaseLipo(fake);
      executable(join(fake, 'codesign'), ['exit 0']);
      executable(join(fake, 'ditto'), ['exec /usr/bin/ditto "$@"']);
      executable(join(fake, 'xcrun'), ['exit 0']);
      executable(join(fake, 'shasum'), ['printf "' + 'c'.repeat(64) + '  runtime-raiders-agent.zip\\n"']);
      const fixture = disposableReleaseBuilder(root);
      const quartet = [
        'install.sh',
        'runtime-raiders-agent.zip',
        'runtime-raiders-agent.zip.sha256',
        'runtime-raiders-agent.update.json',
      ];
      const output = immutableReleaseOutput(root, fixture);
      mkdirSync(output, { recursive: true });
      for (const target of quartet) writeFileSync(join(output, target), `old ${target}`);

      const result = invoke(
        fixture.build,
        releaseBuildArgs(
          fixture.releaseSHA,
          '--output', output,
          '--scratch-path', join(root, 'scratch'),
        ),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_TEST_LOG: buildLog,
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('release output must be absent');
      expect(existsSync(buildLog)).toBe(false);
      for (const target of quartet) {
        expect(readFileSync(join(output, target), 'utf8'), target).toBe(`old ${target}`);
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
      fakeReleaseLipo(fake);
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
        const orphanOutput = immutableReleaseOutput(
          root,
          fixture,
          `orphan-${target.replaceAll('.', '-')}`,
        );
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

        const symlinkOutput = immutableReleaseOutput(
          root,
          fixture,
          `symlink-${target.replaceAll('.', '-')}`,
        );
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

describe('Runtime Raiders release gates', () => {
  it('keeps validator scratch out of the exact two-file private migrator record', () => {
    const runbook = readFileSync(releaseRunbook, 'utf8');
    const privateStart = runbook.indexOf('### Prepare the private sequence-eight migrator record');
    const privateEnd = runbook.indexOf('## Gate 3:', privateStart);
    expect(privateStart).toBeGreaterThanOrEqual(0);
    expect(privateEnd).toBeGreaterThan(privateStart);
    const privateSection = runbook.slice(privateStart, privateEnd);

    expect(privateSection).toContain('PRIVATE_WORK="$(mktemp -d');
    expect(privateSection).toContain('"$PRIVATE_WORK/validator-scratch"');
    expect(privateSection).not.toContain('"$PRIVATE_OUTPUT/validator-scratch"');
    expect(privateSection).toContain('EXPECTED_PRIVATE_FILES=');
    expect(privateSection).toContain('ACTUAL_PRIVATE_FILES=');
    expect(privateSection).toContain('test "$ACTUAL_PRIVATE_FILES" = "$EXPECTED_PRIVATE_FILES"');
    expect(privateSection).toContain('PRIVATE_STAGE="$PRIVATE_WORK/private-record"');
    expect(privateSection).toContain('/bin/mv "$PRIVATE_STAGE" "$PRIVATE_OUTPUT"');
    expect(privateSection).toContain('FINAL_PRIVATE_FILES=');
    expect(privateSection).toContain('test "$FINAL_PRIVATE_FILES" = "$EXPECTED_PRIVATE_FILES"');
  });

  it('requires reproducible validator builds to remove both scratch directories', () => {
    const source = readFileSync(validatorReproducibility, 'utf8');
    expect(source).toContain('[ ! -e "$probe_root/$run-scratch" ]');
    expect(source).toContain('[ ! -L "$probe_root/$run-scratch" ]');
  });

  it('runs Gate 1 in the exact fail-fast order with disposable fake boundaries only', () => {
    const packageJSON = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJSON.scripts?.['canary:lifecycle-test'])
      .toBe('bash scripts/test/runtime-raiders-lifecycle.sh');

    const source = readFileSync(lifecycleGate, 'utf8');
    const orderedCommands = [
      'sh -n companion/packaging/install.sh',
      'bash -n scripts/release/build-runtime-raiders-agent.sh',
      'swift test --disable-sandbox --package-path companion',
      'bash scripts/test/runtime-raiders-validator-reproducibility.sh',
      'npx --no-install vitest run --no-file-parallelism',
    ];
    let prior = -1;
    for (const command of orderedCommands) {
      const current = source.indexOf(command);
      expect(current, `${command} must be present after the prior command`).toBeGreaterThan(prior);
      prior = current;
    }

    expect(source).toMatch(/mktemp -d/);
    expect(source).toMatch(/trap .*EXIT/);
    expect(source).toMatch(/cleanup\(\) \{\s+status=\$\?.*trap - EXIT HUP INT TERM.*exit "\$status"/s);
    expect(source).toMatch(/trap 'exit 129' HUP.*trap 'exit 130' INT.*trap 'exit 143' TERM/s);
    expect(source).toContain('RUNTIME_RAIDERS_TEST_FAKE_NETWORK');
    expect(source).toContain('RUNTIME_RAIDERS_TEST_FAKE_LAUNCHD');
    expect(source).toContain('CLANG_MODULE_CACHE_PATH');
    expect(source).toContain('SWIFTPM_MODULECACHE_OVERRIDE');
    expect(source).toContain('export HOME="$gate_root/home"');
    expect(source).toContain('export CFFIXED_USER_HOME="$gate_root/home"');
    expect(source).toContain('--scratch-path "$gate_root/swift-scratch"');
    expect(source).toContain('--disable-automatic-resolution');
    expect(source).toContain('--skip-update');
    expect(source).toContain('npm_config_offline=true');
    expect(source).toContain('/usr/bin/sandbox-exec');
    expect(source).toContain('scripts/test/runtime-raiders-gate1.sb');
    expect(source).toContain('real_support="$original_home/Library/Application Support/Runtime Raiders"');
    expect(source).not.toMatch(/\bCaddy\b|\bPi\b|\bpublish(?:ed|ing|ation)?\b|\braiders[ \t]+on\b/i);
  });

  it('keeps Gate 2 local, unpublished, owner-only, and complete before any real boundary is authorized', () => {
    const syntax = spawnSync('/bin/bash', ['-n', signedReleaseGate], { encoding: 'utf8' });
    expect(syntax.status, `${syntax.stdout}${syntax.stderr}`).toBe(0);
    const pathSyntax = spawnSync('/bin/bash', ['-n', signedReleasePaths], { encoding: 'utf8' });
    expect(pathSyntax.status, `${pathSyntax.stdout}${pathSyntax.stderr}`).toBe(0);

    const source = readFileSync(signedReleaseGate, 'utf8');
    const pathSource = readFileSync(signedReleasePaths, 'utf8');
    for (const filename of [
      'install.sh',
      'runtime-raiders-agent.zip',
      'runtime-raiders-agent.zip.sha256',
      'runtime-raiders-agent.update.json',
    ]) {
      expect(source).toContain(filename);
    }
    for (const required of [
      '/usr/bin/codesign',
      '/usr/sbin/spctl',
      '/usr/bin/xcrun stapler validate',
      'runtime-raiders-release-validator',
      'Runtime Raiders Agent.app',
      'Runtime Raiders Launcher.app',
      'RUNTIME_RAIDERS_CODESIGN_IDENTITY',
      '--timestamp=none',
      'gate_verify_installer_binding',
      'gate_process_capture',
      'gate_process_stop_all',
      'RUNTIME_RAIDERS_GATE2_FAKE_NETWORK',
      'RUNTIME_RAIDERS_GATE2_FAKE_LAUNCHD',
      'launcher-active',
      'launcher-fallback',
      'launcher-held-trial',
      'launcher-missing-state',
      'launcher-malformed-state',
      'launcher-unsafe-mode',
      'launcher-symlink-state',
      'launcher-identity-mismatch',
      'gate2_create_owned_root',
    ]) {
      expect(source).toContain(required);
    }
    for (const migrationOnlySurface of [
      'legacy_seed',
      'write_legacy_fixture',
      'gate_fingerprint_migration_surface',
      'migration-failure-fingerprint',
      '.migration-v1',
    ]) {
      expect(source).not.toContain(migrationOnlySurface);
    }
    expect(pathSource).toMatch(/mktemp -d/);
    expect(pathSource).toMatch(/chmod 700/);
    expect(source).toMatch(/trap .*EXIT/);
    expect(source).toMatch(/https?:\/\//);
    expect(source).toMatch(/-f .*install\.sh/);
    expect(source).toMatch(/-L .*install\.sh/);
    expect(source.indexOf('exec 9<>"$lease_fifo"')).toBeGreaterThan(0);
    expect(source.indexOf('exec 9<>"$lease_fifo"')).toBeLessThan(source.indexOf('"$current_agent" __runtime-raiders-installer-lease'));
    expect(source).not.toMatch(/kill[ \t]+-0|\bwait[ \t]+"?\$/);
    expect(source).not.toMatch(/grep -F "(?:RELEASE_SEQUENCE|RELEASE_SHA|VERSION|UPDATE_PROTOCOL_VERSION|TEAM_ID)=/);
    expect(source).not.toMatch(/raiders[ \t]+on|office activation|artifact publication/i);
  });
});
