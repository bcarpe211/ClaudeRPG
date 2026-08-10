import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = join(process.cwd(), 'companion/packaging/install.sh');
const build = join(process.cwd(), 'scripts/release/build-runtime-raiders-agent.sh');
const installerRenderer = join(process.cwd(), 'scripts/release/render-runtime-raiders-installer.sh');
const lifecycleGate = join(process.cwd(), 'scripts/test/runtime-raiders-lifecycle.sh');
const signedReleaseGate = join(process.cwd(), 'scripts/test/verify-runtime-raiders-signed-release.sh');
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
    'elif [ "$1" = -verify_arch ]; then',
    '  [ "$#" -eq 4 ] && [ "$2" = arm64 ] && [ "$3" = x86_64 ] || exit 66',
    '  case "${4##*/}" in runtime-raiders-release-validator) [ -x "$4" ];; *) [ "$(cat "$4")" = arm64,x86_64 ];; esac || exit 67',
    '  [ "${FAKE_LIPO_VERIFY_FAIL_TARGET:-}" != "${4##*/}" ] || exit 68',
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

function renderedProtocolTwoInstaller(root: string): string {
  const path = join(root, 'install-protocol-two.sh');
  const validator = join(root, 'embedded-installer-validator');
  executable(validator, [
    'printf "installer-validator %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
    'if [ "$#" -eq 1 ]; then phase=archive; elif [ "$#" -eq 7 ]; then phase=extracted; else exit 64; fi',
    '[ "${FAKE_INSTALLER_VALIDATOR_FAIL:-}" != "$phase" ] || exit 79',
  ]);
  const validatorBytes = readFileSync(validator);
  const validatorSHA = createHash('sha256').update(validatorBytes).digest('hex');
  writeFileSync(path, readFileSync(installer, 'utf8')
    .replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', teamId)
    .replaceAll('__RUNTIME_RAIDERS_COMPANION_VERSION__', migrationCompanionVersion)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SEQUENCE__', migrationReleaseSequence)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_SHA__', releaseSHA)
    .replaceAll('__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__', migrationUpdateProtocolVersion)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__', validatorSHA)
    .replaceAll('__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__', validatorBytes.toString('base64'))
    .replace(
      'failure_checkpoint() { :; }',
      'failure_checkpoint() { [ "${RUNTIME_RAIDERS_TEST_FAIL_AFTER:-}" != "$1" ] || { echo "injected failure after $1" >&2; return 91; }; }',
    )
    .replaceAll(
      '/bin/ln -s "$SHIM" "$command_path"',
      '"$RUNTIME_RAIDERS_TEST_LN" -s "$SHIM" "$command_path"',
    ));
  chmodSync(path, 0o755);
  return path;
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
    '    cat >/dev/null; exit 0;;',
    '  __runtime-raiders-legacy-prepare)',
    '    [ -f "$running" ] || exit 69; : > "$prepared"; printf \'prepared for update\\n\'; exit 0;;',
    '  __runtime-raiders-legacy-resume)',
    '    rm -f "$prepared"; : > "$running"; printf \'resumed legacy\\n\'; exit 0;;',
    '  __runtime-raiders-installer-validate-legacy)',
    '    expected="$HOME/.local/bin/raiders"; record="$HOME/Library/Application Support/Runtime Raiders/state/command-link"; [ "$(cat "$record")" = "$expected" ] && [ -L "$expected" ] && [ "$(readlink "$expected")" = "$HOME/Library/Application Support/Runtime Raiders/raiders" ]; status=$?; exit "$status";;',
    '  __runtime-raiders-installer-protected-state)',
    '    support="$HOME/Library/Application Support/Runtime Raiders"',
    '    (cd "$support" && for root in state outbox; do if [ -d "$root" ]; then printf "D %s " "$root"; /usr/bin/stat -f "%d:%i:%Lp:%u:%g\\n" "$root"; find "$root" -mindepth 1 \\( -name command-link -o -name path-marker-owned -o -name update.lock -o -name prepared-startup.lock \\) -prune -o -print | sort | while IFS= read -r entry; do if [ -d "$entry" ]; then printf "D %s " "$entry"; /usr/bin/stat -f "%d:%i:%Lp:%u:%g\\n" "$entry"; else printf "F %s " "$entry"; /usr/bin/stat -f "%Lp:%u:%g:%l" "$entry"; /usr/bin/shasum -a 256 "$entry"; fi; done; else printf "M %s\\n" "$root"; fi; done); exit 0;;',
    '  __runtime-raiders-installer-status)',
    '    phase="${2:-}"; generation="${3:-}"; intent="${4:-}"; cat >/dev/null',
    '    [ "${FAKE_STATUS_PEER_MISMATCH:-}" != "$phase" ] || exit 83',
    '    case "$phase" in legacy-*) payload="$("$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent" status)";; *) payload="$("$0" status)";; esac',
    '    [ "${FAKE_STATUS_CORRUPTION:-}" != "$phase" ] || exit 82',
    '    printf "%s" "$payload" | grep -F \'"activeRunCount":0\' >/dev/null',
    '    printf "%s" "$payload" | grep -F \'"queuedEventCount":0\' >/dev/null',
    '    case "$phase" in',
    '      legacy-running) printf "%s" "$payload" | grep -F \'"installedReleaseSequence":8\' >/dev/null; printf "%s" "$payload" | grep -F \'"preparedForUpdate":false\' >/dev/null; case "$payload" in *\'"enabled":true\'*) printf \'enabled\\n\';; *) printf \'disabled\\n\';; esac;;',
    '      legacy-prepared) [ "$generation" = enabled ] || [ "$generation" = disabled ]; printf "%s" "$payload" | grep -F \'"installedReleaseSequence":8\' >/dev/null; printf "%s" "$payload" | grep -F \'"preparedForUpdate":true\' >/dev/null;;',
    '      candidate-prepared|candidate-resumed) [ "$generation" = 1 ]; [ "$intent" = enabled ] || [ "$intent" = disabled ]; printf "%s" "$payload" | grep -F \'"installedReleaseSequence":9\' >/dev/null; expected=true; [ "$phase" = candidate-resumed ] && expected=false; printf "%s" "$payload" | grep -F "\\\"preparedForUpdate\\\":$expected" >/dev/null; [ "${FAKE_MUTATE_PROTECTED_AT:-}" != "$phase" ] || printf \'mutated\\n\' >> "$collector_state";;',
    '      *) exit 64;;',
    '    esac; exit 0;;',
    '  __runtime-raiders-installer-resume)',
    '    [ "${2:-}" = 1 ] || exit 64; [ -f "$job" ] || exit 69; rm -f "$prepared"; : > "$resumed"; : > "$running"; printf \'resumed\\n\'; exit 0;;',
    '  uninstall) rm -f "$running"; exit 0;;',
    'esac',
    'state_kind=missing; enabled=false',
    'if [ -f "$collector_state" ]; then',
    '  grep -F \'"enabled":true\' "$collector_state" >/dev/null 2>&1 && { state_kind=enabled; enabled=true; } || state_kind=disabled',
    'fi',
    'daemon=false; [ -f "$running" ] && daemon=true',
    'prepared_value=false; prepared_generation=null; { [ -f "$prepared" ] || [ -f "$lease" ]; } && [ ! -f "$resumed" ] && { prepared_value=true; prepared_generation=1; }',
    'if [ "${1:-}" = status ]; then',
    '  printf \'{"activeRunCount":%s,"availableCompanionVersion":null,"availableReleaseSequence":null,"compiledAdapters":["claude_code","unavailable","codex_cli","available","codex_desktop","available","omp","unavailable"],"daemonRunning":%s,"enabled":%s,"installedCompanionVersion":"0.3.0","installedReleaseSequence":9,"lastSuccessfulUploadMS":null,"persistedState":"%s","preparedForUpdate":%s,"preparedReleaseStateGeneration":%s,"queuedEventCount":0,"serverEnabledSurfaces":["codex_cli","codex_desktop"],"updateCommand":null}\\n\' "${FAKE_ACTIVE_RUN_COUNT:-0}" "$daemon" "$enabled" "$state_kind" "$prepared_value" "$prepared_generation"; exit 0',
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
    FAKE_STATUS_PEER_MISMATCH: '',
    FAKE_CODE_FILE_OWNER: '',
    RUNTIME_RAIDERS_TEST_CODE_FILE: '',
    RUNTIME_RAIDERS_TEST_LOG: join(home, 'commands.log'),
    RUNTIME_RAIDERS_TEST_BINARY_LOG: join(home, 'binary.log'),
    RUNTIME_RAIDERS_TEST_ZIP: files.zip,
    RUNTIME_RAIDERS_TEST_CHECKSUM: files.checksum,
    RUNTIME_RAIDERS_TEST_LN: join(fake, 'ln'),
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
  crossWireArm64Slice?: 'agent' | 'launcher';
  rendererFailure?: boolean;
};

function disposableReleaseBuilder(
  root: string,
  options: ReleaseBuilderFixtureOptions = {},
): ReleaseBuilderFixture {
  const repository = join(root, 'repository');
  const fixtureBuild = join(repository, 'scripts/release/build-runtime-raiders-agent.sh');
  const fixtureRenderer = join(repository, 'scripts/release/render-runtime-raiders-installer.sh');
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
  writeFileSync(
    fixtureRenderer,
    options.rendererFailure ? '#!/bin/sh\nexit 89\n' : readFileSync(installerRenderer),
    { mode: 0o700 },
  );
  writeFileSync(fixtureInstaller, readFileSync(installer));
  writeFileSync(join(repository, 'companion/RELEASE'), readFileSync(join(process.cwd(), 'companion/RELEASE')));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: repository });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Release Test'], { cwd: repository });
  execFileSync('/usr/bin/git', ['add', 'scripts/release/build-runtime-raiders-agent.sh', 'scripts/release/render-runtime-raiders-installer.sh', 'companion/packaging/install.sh', 'companion/RELEASE'], { cwd: repository });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'release fixture'], { cwd: repository });
  const fixtureSHA = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  return { build: fixtureBuild, repository, releaseSHA: fixtureSHA };
}

function releaseBuildArgs(sha: string, ...args: string[]): string[] {
  return ['--release-sha', sha, ...args];
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

function legacySequenceEightFixture(root: string, enabled: boolean): LegacyFixture {
  const home = join(root, 'home');
  const support = join(home, 'Library/Application Support/Runtime Raiders');
  const state = join(support, 'state');
  const app = join(support, 'Runtime Raiders Agent.app');
  const executablePath = join(app, 'Contents/MacOS/runtime-raiders-agent');
  const plist = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const shim = join(support, 'raiders');
  const commandDir = join(home, '.local/bin');
  const commandPath = join(commandDir, 'raiders');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(support, 'outbox'), { recursive: true });
  mkdirSync(commandDir, { recursive: true });
  for (const directory of [support, state, join(support, 'outbox'), join(home, '.local'), commandDir]) chmodSync(directory, 0o700);
  executable(executablePath, [
    'collector_state="$HOME/Library/Application Support/Runtime Raiders/state/collector-state.json"',
    'running="$HOME/.runtime-raiders-test-running"',
    'prepared="$HOME/.runtime-raiders-test-prepared"',
    'if [ "${1:-}" = status ]; then',
    '  enabled=false; state=disabled; grep -F \'"enabled":true\' "$collector_state" >/dev/null 2>&1 && { enabled=true; state=enabled; }',
    '  daemon=false; [ -f "$running" ] && daemon=true',
    '  prepared_value=false; [ -f "$prepared" ] && prepared_value=true',
    '  printf \'{"activeRunCount":%s,"availableCompanionVersion":null,"availableReleaseSequence":null,"compiledAdapters":["claude_code","unavailable","codex_cli","available","codex_desktop","available","omp","unavailable"],"daemonRunning":%s,"enabled":%s,"installedCompanionVersion":"0.2.6","installedReleaseSequence":8,"lastSuccessfulUploadMS":null,"persistedState":"%s","preparedForUpdate":%s,"queuedEventCount":0,"serverEnabledSurfaces":["codex_cli","codex_desktop"],"updateCommand":null}\\n\' "${FAKE_ACTIVE_RUN_COUNT:-0}" "$daemon" "$enabled" "$state" "$prepared_value"; exit 0',
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
  writeFileSync(commandLinkFile, commandPath + '\n'); chmodSync(commandLinkFile, 0o600);
  const enrollment = writeEnrollment(home);
  const collectorState = join(state, 'collector-state.json');
  writeFileSync(collectorState, `{"enabled":${enabled},"files":{"cursor":"preserve"},"version":1}\n`);
  chmodSync(collectorState, 0o600);
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
    environment: env(home, fake, files, commandDir),
  };
}

function releaseStatePath(support: string): string {
  return join(support, 'installation/release-state.json');
}

describe('Runtime Raiders protocol-two installer', () => {
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
      expect(JSON.parse(readFileSync(releaseStatePath(fixture.support), 'utf8')).fallback).toBeNull();
      expect(readFileSync(fixture.plist, 'utf8')).toContain('/launcher/Runtime Raiders Launcher.app/');
      expect(readFileSync(fixture.shim, 'utf8')).toContain('/launcher/Runtime Raiders Launcher.app/');
      const binaryLog = readFileSync(join(fixture.home, 'binary.log'), 'utf8');
      expect(binaryLog.indexOf('__runtime-raiders-legacy-prepare')).toBeLessThan(binaryLog.indexOf('__runtime-raiders-installer-resume 1'));
      expect(readFileSync(fixture.collectorState, 'utf8')).toContain(`"enabled":${enabled}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('migration rollback restores the flat arrangement at every replacement boundary and permits retry', () => {
    const checkpoints = [
      'archive-verification', 'enrollment-decision', 'prepare', 'old-job-stop',
      'launcher-directory', 'releases-directory', 'installation-directory',
      'launcher-placement', 'release-placement', 'state-write', 'plist-replacement',
      'shim-replacement', 'command-link-replacement', 'bootstrap', 'prepared-health', 'resume',
    ];
    for (const checkpoint of checkpoints) {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-rollback-${checkpoint}-`));
      try {
        const fixture = legacySequenceEightFixture(root, true);
        const appBefore = buildCacheIdentity(fixture.app);
        const inodeBefore = statSync(fixture.app).ino;
        const plistBefore = readFileSync(fixture.plist);
        const shimBefore = readFileSync(fixture.shim);
        const enrollmentBefore = readFileSync(fixture.enrollment);
        const stateBefore = readFileSync(fixture.collectorState);
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
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-job')), checkpoint).toBe(true);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-running')), checkpoint).toBe(true);
        const retry = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
        expect(retry.status, `${checkpoint} retry: ${retry.stderr}`).toBe(0);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 120_000);

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

  it('retains the documented one-line piped install and keeps the code out of process arguments', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-piped-v2-'));
    try {
      const home = join(root, 'home'); mkdirSync(home);
      const fake = fakes(root); const files = protocolTwoArtifact(root);
      const script = renderedProtocolTwoInstaller(root);
      const code = oneTimeCodeFile(root);
      const environment = { ...env(home, fake, files), SCRIPT: script, CODE: code };
      const result = spawnSync('/bin/sh', [
        '-c', 'cat "$SCRIPT" | /bin/sh -s -- --code-file "$CODE"',
      ], { env: environment, encoding: 'utf8' });
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
    'rejects protected state mutation at %s and restores the legacy layout',
    (phase) => {
      const root = mkdtempSync(join(tmpdir(), `runtime-raiders-protected-${phase}-`));
      try {
        const fixture = legacySequenceEightFixture(root, false);
        const failed = invoke(renderedProtocolTwoInstaller(root), [], {
          ...fixture.environment,
          FAKE_MUTATE_PROTECTED_AT: phase,
        });
        expect(failed.status).not.toBe(0);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-running'))).toBe(false);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-job'))).toBe(false);
        expect(existsSync(join(fixture.home, '.runtime-raiders-test-prepared')))
          .toBe(phase === 'candidate-prepared');
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

  it('rejects a sequence-eight command record outside the canonical local-bin raiders path', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-wrong-legacy-command-'));
    try {
      const fixture = legacySequenceEightFixture(root, false);
      const alternateDirectory = join(fixture.home, 'bin');
      const alternate = join(alternateDirectory, 'raiders');
      mkdirSync(alternateDirectory, { mode: 0o700 });
      symlinkSync(fixture.shim, alternate);
      writeFileSync(join(fixture.support, 'state/command-link'), alternate + '\n');
      chmodSync(join(fixture.support, 'state/command-link'), 0o600);
      const result = invoke(renderedProtocolTwoInstaller(root), [], fixture.environment);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('exact sequence-8 installation');
      expect(existsSync(join(fixture.home, '.runtime-raiders-test-prepared'))).toBe(false);
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
          writeFileSync(join(commandDir, 'raiders'), 'user command\n');
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
      const command = join(commandDir, 'raiders');
      const uninstall = spawnSync(command, ['uninstall'], { env: environment, encoding: 'utf8' });
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(existsSync(join(home, 'Library/Application Support/Runtime Raiders'))).toBe(false);
      expect(existsSync(command)).toBe(false);
      expect(existsSync(join(home, 'Library/LaunchAgents', `${label}.plist`))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Runtime Raiders release build', () => {
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
      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', join(root, 'output'), '--scratch-path', join(root, 'scratch')),
        {
          ...process.env,
          PATH: fake + ':/usr/bin:/bin',
          RUNTIME_RAIDERS_CODESIGN_IDENTITY: 'Developer ID Application: Test',
          RUNTIME_RAIDERS_NOTARY_PROFILE: 'runtime-raiders-notary',
          RUNTIME_RAIDERS_TEAM_ID: teamId,
        },
      );
      expect(result.status, result.stderr).toBe(89);
      expect(existsSync(join(root, 'output'))).toBe(false);
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
      const result = invoke(
        fixture.build,
        releaseBuildArgs(fixture.releaseSHA, '--output', join(root, 'output'), '--scratch-path', join(root, 'scratch')),
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
        if (state === 'dirty tracked') writeFileSync(join(fixture.repository, 'companion/RELEASE'), [
          'version=1',
          'companion_version=0.3.1',
          'release_sequence=10',
          'update_protocol_version=2',
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
      fakeReleaseLipo(fake);
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
      expect(readFileSync(join(root, 'relative-scratch/arm64-apple-macosx/release/runtime-raiders-launcher'), 'utf8')).toBe('arm64');
      expect(readFileSync(join(root, 'relative-scratch/x86_64-apple-macosx/release/runtime-raiders-launcher'), 'utf8')).toBe('x86_64');
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
        const output = join(root, 'output');

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
        const output = join(root, 'output');

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
      const output = join(root, 'output');
      const scratch = join(root, 'scratch');
      const releaseValidator = productionReleaseValidator(root);
      const loggingReleaseValidator = join(root, 'logging-release-validator');
      executable(loggingReleaseValidator, [
        'printf "release-validator %s\\n" "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"',
        'if [ "$#" -eq 1 ]; then exec "$RUNTIME_RAIDERS_TEST_PRODUCTION_RELEASE_VALIDATOR" "$@"; fi',
        '[ "$#" -eq 7 ]',
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
      expect(result.stdout).toContain('Built unpublished signed quartet');
      expect(buildCacheIdentity(join(process.cwd(), 'companion/.build'))).toEqual(repositoryCacheBefore);
      expect(readFileSync(join(scratch, 'arm64-apple-macosx/release/raiders'), 'utf8')).toBe('arm64');
      expect(readFileSync(join(scratch, 'x86_64-apple-macosx/release/raiders'), 'utf8')).toBe('x86_64');
      expect(readFileSync(join(scratch, 'arm64-apple-macosx/release/runtime-raiders-launcher'), 'utf8')).toBe('arm64');
      expect(readFileSync(join(scratch, 'x86_64-apple-macosx/release/runtime-raiders-launcher'), 'utf8')).toBe('x86_64');
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
      expect(commandLines.filter((line) => line.startsWith('lipo -verify_arch arm64 x86_64 '))).toHaveLength(3);
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
      expect(firstVerifications).toHaveLength(5);
      expect(firstVerifications[0]).not.toContain('/archive-validation.');
      expect(firstVerifications[1]).not.toContain('/archive-validation.');
      expect(firstVerifications[2]).not.toContain('/archive-validation.');
      expect(firstVerifications[3]).not.toContain('/archive-validation.');
      expect(firstVerifications[4]).toContain('/archive-validation.');
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
      const output = join(root, 'output');
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

describe('Runtime Raiders release gates', () => {
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
      'npx --no-install vitest run',
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
    expect(source).not.toMatch(/Library\/Application Support\/Runtime Raiders/);
    expect(source).not.toMatch(/\bCaddy\b|\bPi\b|\bpublish(?:ed|ing|ation)?\b|\braiders[ \t]+on\b/i);
  });

  it('keeps Gate 2 local, unpublished, owner-only, and complete before any real boundary is authorized', () => {
    const syntax = spawnSync('/bin/bash', ['-n', signedReleaseGate], { encoding: 'utf8' });
    expect(syntax.status, `${syntax.stdout}${syntax.stderr}`).toBe(0);

    const source = readFileSync(signedReleaseGate, 'utf8');
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
      'gate_fingerprint_migration_surface',
      '__runtime-raiders-installer-status legacy-running false',
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
      'migration-failure-fingerprint',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).toMatch(/mktemp -d/);
    expect(source).toMatch(/chmod 700/);
    expect(source).toMatch(/trap .*EXIT/);
    expect(source).toMatch(/https?:\/\//);
    expect(source).toMatch(/-f .*install\.sh/);
    expect(source).toMatch(/-L .*install\.sh/);
    expect(source).toMatch(/gate_env\(\) \{\s+local home="\$1"\s+shift\s+gate_run_without_release_credentials env HOME="\$home"/s);
    expect(source.indexOf('exec 9<>"$lease_fifo"')).toBeGreaterThan(0);
    expect(source.indexOf('exec 9<>"$lease_fifo"')).toBeLessThan(source.indexOf('"$current_agent" __runtime-raiders-installer-lease'));
    expect(source).not.toMatch(/kill[ \t]+-0|\bwait[ \t]+"?\$/);
    expect(source).not.toMatch(/grep -F "(?:RELEASE_SEQUENCE|RELEASE_SHA|VERSION|UPDATE_PROTOCOL_VERSION|TEAM_ID)=/);
    expect(source).not.toMatch(/raiders[ \t]+on|office activation|artifact publication/i);
  });
});
