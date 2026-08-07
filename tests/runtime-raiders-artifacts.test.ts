import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/pi/runtime-raiders-artifacts.sh');
const INSTALLER_TEMPLATE = resolve('companion/packaging/install.sh');
const releaseSha = 'b'.repeat(40);
const companionVersion = '0.2.0';
const releaseSequence = '1';
const updateProtocolVersion = 1;
const zipUrl = 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip';
const publicTargets = [
  ['installer', 'https://raiders.redlattice.com/install.sh', '1048576'],
  ['zip', 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip', '134217728'],
  ['checksum', 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256', '4096'],
  ['manifest', 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json', '65536'],
] as const;
const publicHealthURL = 'https://raiders.redlattice.com/health';
const localHealthURL = 'http://127.0.0.1:8080/health';
const roots: string[] = [];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function publicManifest(
  selectedReleaseSha: string,
  selectedReleaseSequence: number,
  selectedCompanionVersion: string,
  zipDigest: string,
): string {
  return JSON.stringify({
    companion_version: selectedCompanionVersion,
    manifest_version: 1,
    release_sequence: selectedReleaseSequence,
    release_sha: selectedReleaseSha,
    update_protocol_version: updateProtocolVersion,
    zip_sha256: zipDigest,
    zip_url: zipUrl,
  }) + '\n';
}

function sourceTriplet(
  root: string,
  selectedReleaseSha = releaseSha,
  selectedReleaseSequence = Number(releaseSequence),
  selectedCompanionVersion = companionVersion,
) {
  const source = join(root, 'source');
  mkdirSync(source);
  const installer = join(source, 'install.sh');
  const zip = join(source, 'runtime-raiders-agent.zip');
  const checksum = join(source, 'runtime-raiders-agent.zip.sha256');
  const updateManifest = join(source, 'runtime-raiders-agent.update.json');
  writeFileSync(installer, [
    '#!/bin/sh',
    "ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'",
    "CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'",
    "TEAM_ID='ABCDE12345'",
    '',
  ].join('\n'));
  writeFileSync(zip, 'signed-test-archive');
  writeFileSync(checksum, `${sha256(zip)}  runtime-raiders-agent.zip\n`);
  writeFileSync(updateManifest, publicManifest(
    selectedReleaseSha,
    selectedReleaseSequence,
    selectedCompanionVersion,
    sha256(zip),
  ));
  return { source, installer, zip, checksum, updateManifest };
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-raiders-artifacts-'));
  roots.push(root);
  const artifactRoot = join(root, 'store');
  const fakes = join(root, 'fakes');
  const commandLog = join(root, 'commands.log');
  const curlState = join(root, 'curl-state');
  mkdirSync(join(artifactRoot, 'releases'), { recursive: true, mode: 0o755 });
  chmodSync(artifactRoot, 0o755);
  mkdirSync(fakes);
  mkdirSync(curlState);
  writeFileSync(commandLog, '');

  executable(join(fakes, 'id'), `
test "$1" = -u && printf '0\\n'`);

  executable(join(fakes, 'sha256sum'), `
exec /usr/bin/shasum -a 256 "$@"`);

  executable(join(fakes, 'node'), `
if test "\${RUNTIME_RAIDERS_TEST_INVALID_CANONICAL_PUBLIC_MANIFEST:-0}" = 1; then
  case "\${2:-}" in
    */.verify.*/*) exit 1 ;;
  esac
fi
exec "$RUNTIME_RAIDERS_TEST_REAL_NODE" "$@"`);

  executable(join(fakes, 'flock'), `
printf 'flock %s\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
if test "\${RUNTIME_RAIDERS_TEST_FLOCK_BUSY:-0}" = 1; then exit 1; fi
test "\${1:-}" = -n
fd=\${2:-}
case "$fd" in *[!0-9]*|'') exit 64;; esac
exec /usr/bin/perl -MFcntl=:flock -e '
  my $fd = shift;
  open(my $handle, ">&=$fd") or exit 64;
  flock($handle, LOCK_EX | LOCK_NB) or exit 1;
' "$fd"`);

  executable(join(fakes, 'stat'), `
test "$1" = -c && test "$3" = --
case "$2" in
  '%u:%g:%a') mode=$(/usr/bin/stat -f %Lp "$4"); printf '0:0:%s\\n' "$mode" ;;
  '%d:%i') /usr/bin/stat -f '%d:%i' "$4" ;;
  '%u:%g')
    case "$4" in
      */current) printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SELECTOR_OWNER:-0:0}" ;;
      *) printf '0:0\\n' ;;
    esac
    ;;
  *) exit 64 ;;
esac`);

  executable(join(fakes, 'install'), `
printf 'install %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
if test -n "\${RUNTIME_RAIDERS_TEST_PRECOMMIT_SIGNAL:-}"; then
  kill "-\${RUNTIME_RAIDERS_TEST_PRECOMMIT_SIGNAL}" "$PPID"
  /bin/sleep 0.05
  exit 65
fi
if test "\${RUNTIME_RAIDERS_TEST_FAIL_INSTALL:-0}" = 1; then
  printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SENSITIVE:-unexpected install failure}" >&2
  exit 65
fi
set -- "$@"
filtered=
while test "$#" -gt 0; do
  case "$1" in
    -o|-g) shift 2 ;;
    --) shift ;;
    *) filtered="$filtered '$1'"; shift ;;
  esac
done
eval "set -- $filtered"
exec /usr/bin/install "$@"`);

  executable(join(fakes, 'chown'), `
printf 'chown %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"`);

  executable(join(fakes, 'curl'), `
printf 'curl %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
first_argument=\${1:-}
if test -n "\${RUNTIME_RAIDERS_TEST_CURL_CONFIG:-}" && test "$first_argument" != --disable; then
  printf 'curl-config-loaded\\n' >> "$RUNTIME_RAIDERS_TEST_LOG"
  exit 64
fi
test "$first_argument" = --disable
shift
output=
headers=
url=
max_size=
protocol=
write_out=
connect_timeout=
max_time=
seen_no_location=0
seen_fail=0
seen_silent=0
seen_show_error=0
while test "$#" -gt 0; do
  case "$1" in
    --connect-timeout) test -z "$connect_timeout"; connect_timeout=$2; shift 2 ;;
    --max-time) test -z "$max_time"; max_time=$2; shift 2 ;;
    --dump-header) test -z "$headers"; headers=$2; shift 2 ;;
    --write-out) test "$2" = '%{http_code}'; write_out=1; shift 2 ;;
    --max-filesize) test -z "$max_size"; max_size=$2; shift 2 ;;
    --proto) test -z "$protocol"; case "$2" in '=https'|'=http') protocol=$2 ;; *) exit 64 ;; esac; shift 2 ;;
    --output) test -z "$output"; output=$2; shift 2 ;;
    --no-location) test "$seen_no_location" = 0; seen_no_location=1; shift ;;
    --fail) test "$seen_fail" = 0; seen_fail=1; shift ;;
    --silent) test "$seen_silent" = 0; seen_silent=1; shift ;;
    --show-error) test "$seen_show_error" = 0; seen_show_error=1; shift ;;
    --disable|--location|--location-trusted|--config|-K|--next) exit 64 ;;
    https://*|http://127.0.0.1:8080/health) test -z "$url"; url=$1; shift ;;
    *) exit 64 ;;
  esac
done
test "$connect_timeout" = 3
case "$max_time" in 5|15) ;; *) exit 64 ;; esac
test "$seen_no_location" = 1 && test "$seen_fail" = 1 &&
  test "$seen_silent" = 1 && test "$seen_show_error" = 1
test -n "$output" && test -n "$url" && test -n "$protocol" && test -n "$write_out"
case "$url:$max_size" in
  'https://raiders.redlattice.com/install.sh:1048576')
    label=installer; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/install.sh" ;;
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip:134217728')
    label=zip; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/downloads/runtime-raiders-agent.zip" ;;
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256:4096')
    label=checksum; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/downloads/runtime-raiders-agent.zip.sha256" ;;
  'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json:65536')
    label=manifest; source="$RUNTIME_RAIDERS_ARTIFACT_ROOT/current/downloads/runtime-raiders-agent.update.json" ;;
  'https://raiders.redlattice.com/health:') label=public-health ;;
  'http://127.0.0.1:8080/health:') label=local-health ;;
  *) exit 64 ;;
esac
selected_release=$(/usr/bin/readlink "$RUNTIME_RAIDERS_ARTIFACT_ROOT/current")
selected_sha=\${selected_release##*/}
count_file="$RUNTIME_RAIDERS_TEST_CURL_STATE_DIR/$selected_sha-$label"
count=0
test ! -f "$count_file" || count=$(/bin/cat "$count_file")
count=$((count + 1))
printf '%s\\n' "$count" > "$count_file"
if test "\${RUNTIME_RAIDERS_TEST_FAIL_LABEL:-}" = "$label" &&
    test "$count" -le "\${RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS:-0}"; then
  case "\${RUNTIME_RAIDERS_TEST_FAIL_MODE:-transport}" in
    transport) exit 28 ;;
    status) printf '503'; exit 22 ;;
    *) exit 64 ;;
  esac
fi
case "$label" in
  installer)
    test "$protocol" = '=https' && test "$max_time" = 15 && test "$output" != /dev/null &&
      test -n "$headers" || exit 64
    test "\${RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_INSTALLER_FETCH:-0}" = 0 || exit 22
    corrupt=\${RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_INSTALLER_FETCH:-0}
    missing_no_store=\${RUNTIME_RAIDERS_TEST_PUBLIC_INSTALLER_MISSING_NO_STORE:-0}
    missing_nosniff=\${RUNTIME_RAIDERS_TEST_PUBLIC_INSTALLER_MISSING_NOSNIFF:-0}
    ;;
  zip)
    test "$protocol" = '=https' && test "$max_time" = 15 && test "$output" != /dev/null &&
      test -n "$headers" || exit 64
    test "\${RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_ZIP_FETCH:-0}" = 0 || exit 22
    corrupt=\${RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_ZIP_FETCH:-0}
    missing_no_store=\${RUNTIME_RAIDERS_TEST_PUBLIC_ZIP_MISSING_NO_STORE:-0}
    missing_nosniff=\${RUNTIME_RAIDERS_TEST_PUBLIC_ZIP_MISSING_NOSNIFF:-0}
    ;;
  checksum)
    test "$protocol" = '=https' && test "$max_time" = 15 && test "$output" != /dev/null &&
      test -n "$headers" || exit 64
    test "\${RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_CHECKSUM_FETCH:-0}" = 0 || exit 22
    corrupt=\${RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_CHECKSUM_FETCH:-0}
    missing_no_store=\${RUNTIME_RAIDERS_TEST_PUBLIC_CHECKSUM_MISSING_NO_STORE:-0}
    missing_nosniff=\${RUNTIME_RAIDERS_TEST_PUBLIC_CHECKSUM_MISSING_NOSNIFF:-0}
    ;;
  manifest)
    test "$protocol" = '=https' && test "$max_time" = 15 && test "$output" != /dev/null &&
      test -n "$headers" || exit 64
    test "\${RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_MANIFEST_FETCH:-0}" = 0 || exit 22
    corrupt=\${RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_MANIFEST_FETCH:-0}
    missing_no_store=\${RUNTIME_RAIDERS_TEST_PUBLIC_MANIFEST_MISSING_NO_STORE:-0}
    missing_nosniff=\${RUNTIME_RAIDERS_TEST_PUBLIC_MANIFEST_MISSING_NOSNIFF:-0}
    ;;
  public-health)
    test "$protocol" = '=https' && test "$max_time" = 15 && test "$output" = /dev/null &&
      test -z "$headers" || exit 64
    test "\${RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_HEALTH:-0}" = 0 || exit 22
    printf '200'
    exit 0
    ;;
  local-health)
    test "$protocol" = '=http' && test "$max_time" = 5 && test "$output" = /dev/null &&
      test -z "$headers" || exit 64
    test "\${RUNTIME_RAIDERS_TEST_FAIL_LOCAL_HEALTH:-0}" = 0 || exit 22
    printf '200'
    exit 0
    ;;
esac
curl_result=0
/bin/cp "$source" "$output"
if test "$corrupt" = 1; then printf '%s\\n' 'corrupt public artifact' > "$output"; fi
if test "$label" = installer && test "\${RUNTIME_RAIDERS_TEST_PUBLIC_INSTALLER_OVERSIZED:-0}" = 1; then
  /usr/bin/perl -e 'print "x" x 1048577' > "$output"
  curl_result=63
fi
{
  printf '%s\\n' 'HTTP/2 200'
  if test "$missing_no_store" != 1; then printf '%s\\n' 'Cache-Control: no-store'; fi
  if test "$missing_nosniff" != 1; then printf '%s\\n' 'X-Content-Type-Options: nosniff'; fi
  printf '\\n'
} > "$headers"
printf '200'
exit "$curl_result"`);

  executable(join(fakes, 'sleep'), `
test "$#" = 1 && test "$1" = 1
printf 'sleep 1\\n' >> "$RUNTIME_RAIDERS_TEST_LOG"`);

  executable(join(fakes, 'mv'), `
printf 'mv %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
case " $* " in
  *"/releases/"*)
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_RELEASE_MV:-0}" = 1; then
      printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SENSITIVE:-unexpected release rename failure}" >&2
      exit 65
    fi
    ;;
  *"/.current."*)
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_SELECTOR_MV:-0}" = 1; then
      printf '%s\\n' "\${RUNTIME_RAIDERS_TEST_SENSITIVE:-unexpected selector rename failure}" >&2
      exit 65
    fi
    ;;
  *"/.withdrawn."*)
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_WITHDRAW_MV:-0}" = 1; then exit 65; fi
    ;;
esac
translate_no_target_directory=0
no_clobber=0
while test "$#" -gt 0; do
  case "$1" in
    -T) translate_no_target_directory=1; shift ;;
    -n) no_clobber=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
last=
for argument in "$@"; do last=$argument; done
if test "\${RUNTIME_RAIDERS_TEST_RACE_RELEASE:-0}" = 1; then
  case "$last" in
    */releases/*)
      /bin/mkdir "$last"
      printf 'preexisting' > "$last/preexisting"
      ;;
  esac
fi
if test "$no_clobber" = 1 && { test -e "$last" || test -L "$last"; }; then exit 0; fi
if test "$translate_no_target_directory" = 1; then
  exec /bin/mv -h "$@"
fi
exec /bin/mv "$@"`);

  executable(join(fakes, 'unlink'), `
printf 'unlink %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
if test "\${RUNTIME_RAIDERS_TEST_FAIL_UNLINK:-0}" = 1; then exit 65; fi
if test "\${1:-}" = --; then shift; fi
exec /bin/unlink "$@"`);

  executable(join(fakes, 'rmdir'), `
printf 'rmdir %s\\n' "$*" >> "$RUNTIME_RAIDERS_TEST_LOG"
case "$*" in
  */.publication.lock)
    if test -n "\${RUNTIME_RAIDERS_TEST_POSTCOMMIT_SIGNAL:-}"; then
      kill "-\${RUNTIME_RAIDERS_TEST_POSTCOMMIT_SIGNAL}" "$PPID"
      /bin/sleep 0.05
    fi
    if test "\${RUNTIME_RAIDERS_TEST_FAIL_LOCK_CLEANUP:-0}" = 1; then exit 65; fi
    ;;
esac
if test "\${1:-}" = --; then shift; fi
exec /bin/rmdir "$@"`);

  return { root, artifactRoot, fakes, commandLog, curlState };
}

function publicationFixture(selectedReleaseSha = releaseSha) {
  const environment = fixture();
  const files = sourceTriplet(environment.artifactRoot);
  const args = [
    'publish',
    '--source', files.source,
    '--release-sha', selectedReleaseSha,
    '--installer-sha256', sha256(files.installer),
    '--zip-sha256', sha256(files.zip),
    '--checksum-sha256', sha256(files.checksum),
    '--release-sequence', releaseSequence,
    '--companion-version', companionVersion,
    '--update-manifest-sha256', sha256(files.updateManifest),
  ];
  return { ...environment, files, args, originalArgs: [...args], releaseSha: selectedReleaseSha };
}

type PublicationFixture = ReturnType<typeof publicationFixture>;

function run(
  environment: ReturnType<typeof fixture>,
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${environment.fakes}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_ARTIFACT_ROOT: environment.artifactRoot,
      RUNTIME_RAIDERS_TEST_LOG: environment.commandLog,
      RUNTIME_RAIDERS_TEST_CURL_STATE_DIR: environment.curlState,
      RUNTIME_RAIDERS_CURL: join(environment.fakes, 'curl'),
      RUNTIME_RAIDERS_NODE: join(environment.fakes, 'node'),
      RUNTIME_RAIDERS_SLEEP: join(environment.fakes, 'sleep'),
      RUNTIME_RAIDERS_TEST_REAL_NODE: process.execPath,
      ...extraEnvironment,
    },
  });
}

function runPublish(f: PublicationFixture, extraEnvironment: NodeJS.ProcessEnv = {}) {
  const sourceArguments: Array<[number, string]> = [
    [6, f.files.installer],
    [8, f.files.zip],
    [10, f.files.checksum],
    [16, f.files.updateManifest],
  ];
  for (const [argument, file] of sourceArguments) {
    if (f.args[argument] === f.originalArgs[argument] && existsSync(file)) {
      f.args[argument] = sha256(file);
    }
  }
  return run(f, f.args, extraEnvironment);
}

function setPublicationIdentity(
  f: PublicationFixture,
  selectedReleaseSha: string,
  selectedReleaseSequence: number,
  selectedCompanionVersion = companionVersion,
): void {
  f.args[4] = selectedReleaseSha;
  f.args[12] = String(selectedReleaseSequence);
  f.args[14] = selectedCompanionVersion;
  writeFileSync(f.files.updateManifest, publicManifest(
    selectedReleaseSha,
    selectedReleaseSequence,
    selectedCompanionVersion,
    sha256(f.files.zip),
  ));
  f.args[16] = sha256(f.files.updateManifest);
}

function runStatus(f: PublicationFixture, extraEnvironment: NodeJS.ProcessEnv = {}) {
  return run(f, ['status'], extraEnvironment);
}

function runWithdraw(
  f: PublicationFixture,
  selectedReleaseSha = f.releaseSha,
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return run(f, ['withdraw', '--release-sha', selectedReleaseSha], extraEnvironment);
}

function postCommitBashEnv(f: PublicationFixture, action: 'fail-output' | 'signal'): string {
  const bashEnv = join(f.root, `post-commit-${action}.sh`);
  const actionLine = action === 'fail-output'
    ? 'return 74'
    : 'kill "-$RUNTIME_RAIDERS_TEST_POSTCOMMIT_SIGNAL" "$$"';
  writeFileSync(bashEnv, [
    'printf() {',
    '  case "${2:-}" in',
    '    active_release=*) ' + actionLine + ';;',
    '  esac',
    '  builtin printf "$@"',
    '}',
    '',
  ].join('\n'));
  return bashEnv;
}

function rollbackRaceEnvironment(f: PublicationFixture, replacementSelector: string): NodeJS.ProcessEnv {
  const hook = join(f.root, 'rollback-race');
  const state = join(f.root, 'rollback-race.state');
  executable(hook, `
test ! -e "$RUNTIME_RAIDERS_TEST_ROLLBACK_HOOK_STATE"
printf 'rollback-race\\n' >> "$RUNTIME_RAIDERS_TEST_LOG"
printf 'called\\n' > "$RUNTIME_RAIDERS_TEST_ROLLBACK_HOOK_STATE"
candidate="$RUNTIME_RAIDERS_ARTIFACT_ROOT/.current.out-of-band.$$"
/bin/ln -s "$RUNTIME_RAIDERS_TEST_OUT_OF_BAND_SELECTOR" "$candidate"
/bin/mv -h "$candidate" "$RUNTIME_RAIDERS_ARTIFACT_ROOT/current"`);
  return {
    RUNTIME_RAIDERS_TEST_BEFORE_ROLLBACK_MUTATION: hook,
    RUNTIME_RAIDERS_TEST_ROLLBACK_HOOK_STATE: state,
    RUNTIME_RAIDERS_TEST_OUT_OF_BAND_SELECTOR: replacementSelector,
  };
}

function expectRejectedBeforeSelection(f: PublicationFixture, result: ReturnType<typeof run>) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(f.root);
  expect(existsSync(join(f.artifactRoot, 'current'))).toBe(false);
  expect(existsSync(join(f.artifactRoot, 'releases', f.releaseSha))).toBe(false);
}

function releaseBytes(artifactRoot: string, sha: string) {
  const release = join(artifactRoot, 'releases', sha);
  const zip = join(release, 'downloads', 'runtime-raiders-agent.zip');
  const checksum = join(release, 'downloads', 'runtime-raiders-agent.zip.sha256');
  expect(existsSync(zip), 'nested release ZIP must exist').toBe(true);
  expect(existsSync(checksum), 'nested release checksum must exist').toBe(true);
  return {
    installer: readFileSync(join(release, 'install.sh')),
    zip: readFileSync(zip),
    checksum: readFileSync(checksum),
    updateManifest: readFileSync(join(release, 'downloads', 'runtime-raiders-agent.update.json')),
    manifest: readFileSync(join(release, '.release-manifest')),
  };
}

function createSelectedV1Release(f: PublicationFixture, selectedReleaseSha: string): string {
  const release = join(f.artifactRoot, 'releases', selectedReleaseSha);
  const downloads = join(release, 'downloads');
  mkdirSync(downloads, { recursive: true, mode: 0o755 });
  chmodSync(release, 0o755);
  chmodSync(downloads, 0o755);
  const installer = join(release, 'install.sh');
  const zip = join(downloads, 'runtime-raiders-agent.zip');
  const checksum = join(downloads, 'runtime-raiders-agent.zip.sha256');
  writeFileSync(installer, readFileSync(f.files.installer), { mode: 0o644 });
  writeFileSync(zip, readFileSync(f.files.zip), { mode: 0o644 });
  writeFileSync(checksum, readFileSync(f.files.checksum), { mode: 0o644 });
  const manifest = join(release, '.release-manifest');
  writeFileSync(manifest, [
    'version=1',
    `release_sha=${selectedReleaseSha}`,
    `installer_sha256=${sha256(installer)}`,
    `zip_sha256=${sha256(zip)}`,
    `checksum_sha256=${sha256(checksum)}`,
    '',
  ].join('\n'), { mode: 0o600 });
  symlinkSync(`releases/${selectedReleaseSha}`, join(f.artifactRoot, 'current'));
  return [
    `active_release=${selectedReleaseSha}`,
    `installer_sha256=${sha256(installer)}`,
    `zip_sha256=${sha256(zip)}`,
    `checksum_sha256=${sha256(checksum)}`,
    '',
  ].join('\n');
}

function createStoredV2Release(
  f: PublicationFixture,
  selectedReleaseSha: string,
  selectedReleaseSequence: number,
): string {
  const release = join(f.artifactRoot, 'releases', selectedReleaseSha);
  const downloads = join(release, 'downloads');
  mkdirSync(downloads, { recursive: true, mode: 0o755 });
  chmodSync(release, 0o755);
  chmodSync(downloads, 0o755);
  const installer = join(release, 'install.sh');
  const zip = join(downloads, 'runtime-raiders-agent.zip');
  const checksum = join(downloads, 'runtime-raiders-agent.zip.sha256');
  const updateManifest = join(downloads, 'runtime-raiders-agent.update.json');
  writeFileSync(installer, readFileSync(f.files.installer), { mode: 0o644 });
  writeFileSync(zip, readFileSync(f.files.zip), { mode: 0o644 });
  writeFileSync(checksum, readFileSync(f.files.checksum), { mode: 0o644 });
  writeFileSync(updateManifest, publicManifest(
    selectedReleaseSha,
    selectedReleaseSequence,
    companionVersion,
    sha256(zip),
  ), { mode: 0o644 });
  writeFileSync(join(release, '.release-manifest'), [
    'version=2',
    `release_sha=${selectedReleaseSha}`,
    `release_sequence=${selectedReleaseSequence}`,
    `companion_version=${companionVersion}`,
    `update_protocol_version=${updateProtocolVersion}`,
    `installer_sha256=${sha256(installer)}`,
    `zip_sha256=${sha256(zip)}`,
    `checksum_sha256=${sha256(checksum)}`,
    `update_manifest_sha256=${sha256(updateManifest)}`,
    '',
  ].join('\n'), { mode: 0o600 });
  return release;
}

function expectNoTemporaryPublicationPaths(artifactRoot: string) {
  expect(readdirSync(artifactRoot).filter((name) =>
    name.startsWith('.stage.') || name.startsWith('.current.') || name.startsWith('.verify.'),
  )).toEqual([]);
}

function expectContentFreeFailure(f: PublicationFixture, result: ReturnType<typeof run>) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(f.root);
  expect(result.stderr).not.toContain('signed-test-archive');
  expect(result.stderr).not.toContain('ABCDE12345');
  expect(result.stderr).not.toContain('provider-user-secret');
}

function runScript(
  files: ReturnType<typeof sourceTriplet>,
  environment: ReturnType<typeof fixture>,
  command: 'publish' | 'status',
) {
  const args = command === 'publish'
    ? [
        'publish',
        '--source', files.source,
        '--release-sha', releaseSha,
        '--installer-sha256', sha256(files.installer),
        '--zip-sha256', sha256(files.zip),
        '--checksum-sha256', sha256(files.checksum),
        '--release-sequence', releaseSequence,
        '--companion-version', companionVersion,
        '--update-manifest-sha256', sha256(files.updateManifest),
      ]
    : ['status'];
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${environment.fakes}:/usr/bin:/bin`,
      RUNTIME_RAIDERS_TEST_MODE: '1',
      RUNTIME_RAIDERS_ARTIFACT_ROOT: environment.artifactRoot,
      RUNTIME_RAIDERS_TEST_LOG: environment.commandLog,
      RUNTIME_RAIDERS_TEST_CURL_STATE_DIR: environment.curlState,
      RUNTIME_RAIDERS_CURL: join(environment.fakes, 'curl'),
      RUNTIME_RAIDERS_NODE: join(environment.fakes, 'node'),
      RUNTIME_RAIDERS_SLEEP: join(environment.fakes, 'sleep'),
      RUNTIME_RAIDERS_TEST_REAL_NODE: process.execPath,
    },
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Runtime Raiders artifact publication', () => {
  it.each([
    ['uppercase release SHA', (f: PublicationFixture) => { f.args[4] = releaseSha.toUpperCase(); }],
    ['short installer digest', (f: PublicationFixture) => { f.args[6] = 'a'.repeat(63); }],
    ['zero release sequence', (f: PublicationFixture) => { f.args[12] = '0'; }],
    ['noncanonical release sequence', (f: PublicationFixture) => { f.args[12] = '01'; }],
    ['unsafe release sequence', (f: PublicationFixture) => { f.args[12] = '9007199254740992'; }],
    ['empty companion version', (f: PublicationFixture) => { f.args[14] = ''; }],
    ['unsafe companion version', (f: PublicationFixture) => { f.args[14] = '0.2.0 beta'; }],
    ['missing installer', (f: PublicationFixture) => { unlinkSync(f.files.installer); }],
    ['missing update manifest', (f: PublicationFixture) => { unlinkSync(f.files.updateManifest); }],
    ['empty ZIP', (f: PublicationFixture) => { writeFileSync(f.files.zip, ''); }],
    ['symlinked checksum', (f: PublicationFixture) => {
      unlinkSync(f.files.checksum);
      symlinkSync(f.files.zip, f.files.checksum);
    }],
    ['symlinked update manifest', (f: PublicationFixture) => {
      unlinkSync(f.files.updateManifest);
      symlinkSync(f.files.zip, f.files.updateManifest);
    }],
    ['unrendered Team ID', (f: PublicationFixture) => {
      writeFileSync(f.files.installer, "TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'\n");
    }],
    ['wrong artifact URL', (f: PublicationFixture) => {
      writeFileSync(f.files.installer, readFileSync(f.files.installer, 'utf8')
        .replace('raiders.redlattice.com', 'example.invalid'));
    }],
    ['second artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "ARTIFACT_URL='https://example.invalid/agent.zip'\n");
    }],
    ['second checksum URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "CHECKSUM_URL='https://example.invalid/agent.zip.sha256'\n");
    }],
    ['indented artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, " ARTIFACT_URL='https://example.invalid/agent.zip'\n");
    }],
    ['exported artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "export ARTIFACT_URL='https://example.invalid/agent.zip'\n");
    }],
    ['compound artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "true; ARTIFACT_URL='https://example.invalid/agent.zip'\n");
    }],
    ['exported checksum URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "export CHECKSUM_URL='https://example.invalid/agent.zip.sha256'\n");
    }],
    ['appended artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "ARTIFACT_URL+='/unexpected'\n");
    }],
    ['appended checksum URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "CHECKSUM_URL+='/unexpected'\n");
    }],
    ['continued artifact URL assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "ARTIFACT_URL\\\n='https://example.invalid/agent.zip'\n");
    }],
    ['continued artifact URL identifier assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "ARTIFACT_\\\nURL='https://example.invalid/agent.zip'\n");
    }],
    ['artifact URL array-element assignment', (f: PublicationFixture) => {
      appendFileSync(f.files.installer, "ARTIFACT_URL[0]='https://example.invalid/agent.zip'\n");
    }],
    ['malformed checksum filename', (f: PublicationFixture) => {
      writeFileSync(f.files.checksum, `${sha256(f.files.zip)}  other.zip\n`);
    }],
    ['extra checksum line', (f: PublicationFixture) => {
      appendFileSync(f.files.checksum, 'extra\n');
    }],
  ])('rejects %s before selecting a release', (_name, mutate) => {
    const f = publicationFixture();
    mutate(f);

    const result = runPublish(f);

    expectRejectedBeforeSelection(f, result);
  });

  it.each([
    ['release sequence', '--release-sequence'],
    ['companion version', '--companion-version'],
    ['update manifest digest', '--update-manifest-sha256'],
  ])('requires %s exactly once', (_name, option) => {
    const missing = publicationFixture();
    const optionIndex = missing.args.indexOf(option);
    missing.args.splice(optionIndex, 2);
    expectRejectedBeforeSelection(missing, run(missing, missing.args));

    const duplicate = publicationFixture();
    const duplicateIndex = duplicate.args.indexOf(option);
    duplicate.args.push(option, duplicate.args[duplicateIndex + 1]);
    expectRejectedBeforeSelection(duplicate, run(duplicate, duplicate.args));
  });

  it.each([
    ['manifest version', (manifest: Record<string, unknown>) => { manifest.manifest_version = 2; }],
    ['release SHA', (manifest: Record<string, unknown>) => { manifest.release_sha = 'a'.repeat(40); }],
    ['release sequence', (manifest: Record<string, unknown>) => { manifest.release_sequence = 2; }],
    ['companion version', (manifest: Record<string, unknown>) => { manifest.companion_version = '9.9.9'; }],
    ['update protocol', (manifest: Record<string, unknown>) => { manifest.update_protocol_version = 2; }],
    ['ZIP digest', (manifest: Record<string, unknown>) => { manifest.zip_sha256 = 'a'.repeat(64); }],
    ['ZIP URL', (manifest: Record<string, unknown>) => { manifest.zip_url = 'https://example.invalid/agent.zip'; }],
    ['extra key', (manifest: Record<string, unknown>) => { manifest.untrusted_url = 'https://example.invalid'; }],
  ])('rejects a public manifest with mismatched %s', (_name, mutate) => {
    const f = publicationFixture();
    const manifest = JSON.parse(readFileSync(f.files.updateManifest, 'utf8'));
    mutate(manifest);
    writeFileSync(f.files.updateManifest, `${JSON.stringify(manifest)}\n`);

    const result = runPublish(f);

    expectRejectedBeforeSelection(f, result);
  });

  it('requires the source directory to contain only the signed quartet', () => {
    const f = publicationFixture();
    writeFileSync(join(f.files.source, 'provider-user-secret.txt'), 'private-extra');

    const result = runPublish(f);

    expectRejectedBeforeSelection(f, result);
    expect(result.stderr).not.toContain('provider-user-secret');
    expect(result.stderr).not.toContain('private-extra');
  });

  it.each([
    ['installer', 6],
    ['ZIP', 8],
    ['checksum', 10],
    ['update manifest', 16],
  ])('rejects a supplied %s digest that does not match its source', (_name, argument) => {
    const f = publicationFixture();
    f.args[argument] = 'a'.repeat(64);

    const result = runPublish(f);

    expectRejectedBeforeSelection(f, result);
  });

  it.each([
    ['copy installation', 'RUNTIME_RAIDERS_TEST_FAIL_INSTALL'],
    ['release rename', 'RUNTIME_RAIDERS_TEST_FAIL_RELEASE_MV'],
    ['selector rename', 'RUNTIME_RAIDERS_TEST_FAIL_SELECTOR_MV'],
  ])('preserves the prior selection and release bytes when %s fails', (_name, failureVariable) => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    const priorPublication = runPublish(f);
    expect(priorPublication.status, priorPublication.stderr).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);

    setPublicationIdentity(f, releaseSha, 2);
    const failed = runPublish(f, {
      [failureVariable]: '1',
      RUNTIME_RAIDERS_TEST_SENSITIVE: `${f.root} provider-user-secret signed-test-archive ABCDE12345`,
    });

    expectContentFreeFailure(f, failed);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expectNoTemporaryPublicationPaths(f.artifactRoot);
    expect(lstatSync(join(f.artifactRoot, '.publication.lock')).isFile()).toBe(true);
  });

  it('refuses concurrent publication when the fd lock is busy without changing selected state', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    const priorPublication = runPublish(f);
    expect(priorPublication.status, priorPublication.stderr).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);
    setPublicationIdentity(f, releaseSha, 2);
    const concurrent = runPublish(f, { RUNTIME_RAIDERS_TEST_FLOCK_BUSY: '1' });

    expect(concurrent.status).not.toBe(0);
    expect(concurrent.stdout).toBe('');
    expect(concurrent.stderr).not.toContain(f.root);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(false);
    expect(readFileSync(f.commandLog, 'utf8')).toContain('flock -n 9');
  });

  it('rejects reuse of an existing v2 release and sequence', () => {
    const f = publicationFixture();
    const first = runPublish(f);
    expect(first.status, first.stderr).toBe(0);
    const publishedBytes = releaseBytes(f.artifactRoot, releaseSha);

    const reused = runPublish(f);

    expectContentFreeFailure(f, reused);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(releaseBytes(f.artifactRoot, releaseSha)).toEqual(publishedBytes);
  });

  it('selects only a release sequence greater than every stored valid v2 release', () => {
    const f = publicationFixture();
    createStoredV2Release(f, 'a'.repeat(40), 1);
    setPublicationIdentity(f, releaseSha, 2);

    const published = runPublish(f);

    expect(published.status, published.stderr).toBe(0);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });

  it.each([
    ['reused', 2],
    ['downgraded', 1],
  ])('rejects a %s sequence even when the highest release was withdrawn', (_name, requestedSequence) => {
    const withdrawnSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, withdrawnSha, 2);
    expect(runPublish(f).status).toBe(0);
    expect(runWithdraw(f, withdrawnSha).status).toBe(0);
    setPublicationIdentity(f, releaseSha, requestedSequence);

    const refused = runPublish(f);

    expectRejectedBeforeSelection(f, refused);
    expect(existsSync(join(f.artifactRoot, 'releases', withdrawnSha))).toBe(true);
  });

  it('fails closed when two valid stored v2 releases reuse a sequence', () => {
    const f = publicationFixture();
    createStoredV2Release(f, 'a'.repeat(40), 1);
    createStoredV2Release(f, 'c'.repeat(40), 1);
    setPublicationIdentity(f, releaseSha, 2);

    const refused = runPublish(f);

    expectRejectedBeforeSelection(f, refused);
  });

  it.each([
    ['damaged v2 release', (f: PublicationFixture) => {
      const release = createStoredV2Release(f, 'a'.repeat(40), 1);
      appendFileSync(join(release, '.release-manifest'), 'extra=true\n');
    }],
    ['malformed release directory name', (f: PublicationFixture) => {
      createStoredV2Release(f, 'not-a-release-sha', 1);
    }],
    ['symlinked release directory', (f: PublicationFixture) => {
      symlinkSync(f.root, join(f.artifactRoot, 'releases', 'a'.repeat(40)), 'dir');
    }],
    ['regular file release entry', (f: PublicationFixture) => {
      writeFileSync(join(f.artifactRoot, 'releases', 'a'.repeat(40)), 'unsafe');
    }],
  ])('does not skip a %s while selecting a new release', (_name, damageStore) => {
    const f = publicationFixture();
    damageStore(f);
    setPublicationIdentity(f, releaseSha, 2);

    const refused = runPublish(f);

    expectRejectedBeforeSelection(f, refused);
  });

  it('leaves the prior selector unchanged when public and private manifests disagree', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    expect(runPublish(f).status).toBe(0);
    setPublicationIdentity(f, releaseSha, 2);
    const manifest = JSON.parse(readFileSync(f.files.updateManifest, 'utf8'));
    manifest.release_sequence = 3;
    writeFileSync(f.files.updateManifest, `${JSON.stringify(manifest)}\n`);
    f.args[16] = sha256(f.files.updateManifest);

    const refused = runPublish(f);

    expectContentFreeFailure(f, refused);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(false);
  });

  it('verifies the complete public quartet, exact headers, and both health paths', () => {
    const f = publicationFixture();
    const curlConfig = join(f.root, 'curlrc');
    writeFileSync(curlConfig, [
      'location',
      'url = "https://example.invalid/extra-transfer"',
      'output = "unexpected-output"',
      '',
    ].join('\n'));

    const published = runPublish(f, { RUNTIME_RAIDERS_TEST_CURL_CONFIG: curlConfig });

    expect(published.status, published.stderr).toBe(0);
    const curlCommands = readFileSync(f.commandLog, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('curl '));
    expect(curlCommands).toHaveLength(6);
    for (const [label, url, maxBytes] of publicTargets) {
      const command = curlCommands.find((line) => line.endsWith(` ${url}`));
      expect(command, label).toMatch(new RegExp(
        '^curl --disable --no-location --proto =https --fail --silent --show-error ' +
        '--connect-timeout 3 --max-time 15 --max-filesize ' + maxBytes +
        ' --dump-header \\S+ --output \\S+ --write-out %\\{http_code\\} ' +
        url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
      ));
      for (const category of ['status', 'size', 'digest', 'cache-control', 'nosniff', 'complete']) {
        expect(published.stderr).toContain(
          `verify label=${label} attempt=1/5 result=ok category=${category}`,
        );
      }
    }
    expect(curlCommands).toContain(
      'curl --disable --no-location --proto =https --fail --silent --show-error ' +
      '--connect-timeout 3 --max-time 15 --output /dev/null --write-out %{http_code} ' + publicHealthURL,
    );
    expect(curlCommands).toContain(
      'curl --disable --no-location --proto =http --fail --silent --show-error ' +
      '--connect-timeout 3 --max-time 5 --output /dev/null --write-out %{http_code} ' + localHealthURL,
    );
    expect(published.stderr).not.toContain(f.root);
    expect(readFileSync(f.commandLog, 'utf8')).not.toContain('curl-config-loaded');
  });

  it('succeeds on the third attempt after two transient request failures', () => {
    const f = publicationFixture();

    const published = runPublish(f, {
      RUNTIME_RAIDERS_TEST_FAIL_LABEL: 'installer',
      RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS: '2',
      RUNTIME_RAIDERS_TEST_FAIL_MODE: 'transport',
    });

    expect(published.status, published.stderr).toBe(0);
    expect(published.stderr).toContain(
      'label=installer attempt=1/5 result=retry category=request',
    );
    expect(published.stderr).toContain(
      'label=installer attempt=2/5 result=retry category=request',
    );
    expect(published.stderr).toContain(
      'label=installer attempt=3/5 result=ok category=complete',
    );
    const commandLog = readFileSync(f.commandLog, 'utf8');
    expect(commandLog.split('\n').filter((line) =>
      line.startsWith('curl ') && line.endsWith(' https://raiders.redlattice.com/install.sh'),
    )).toHaveLength(3);
    expect(commandLog.match(/^sleep 1$/gm)).toHaveLength(2);
  });

  it('stops after five availability attempts and restores the prior selector', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    expect(runPublish(f).status).toBe(0);
    writeFileSync(f.commandLog, '');
    setPublicationIdentity(f, releaseSha, 2);

    const failed = runPublish(f, {
      RUNTIME_RAIDERS_TEST_FAIL_LABEL: 'zip',
      RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS: '5',
      RUNTIME_RAIDERS_TEST_FAIL_MODE: 'status',
    });

    expectContentFreeFailure(f, failed);
    expect(failed.stderr).toContain('label=zip attempt=5/5 result=fail category=status');
    const commandLog = readFileSync(f.commandLog, 'utf8');
    expect(commandLog.split('\n').filter((line) =>
      line.startsWith('curl ') && line.endsWith(
        ' https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
      ),
    )).toHaveLength(5);
    expect(commandLog.match(/^sleep 1$/gm)).toHaveLength(4);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
  });

  it.each([
    [
      'digest',
      'RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_ZIP_FETCH',
      'zip',
      'digest',
      'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
    ],
    [
      'header',
      'RUNTIME_RAIDERS_TEST_PUBLIC_ZIP_MISSING_NO_STORE',
      'zip',
      'cache-control',
      'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip',
    ],
    [
      'canonical manifest',
      'RUNTIME_RAIDERS_TEST_INVALID_CANONICAL_PUBLIC_MANIFEST',
      'manifest',
      'manifest',
      'https://raiders.redlattice.com/downloads/runtime-raiders-agent.update.json',
    ],
  ])('does not retry a deterministic %s failure after HTTP 200', (
    _name,
    failure,
    label,
    category,
    url,
  ) => {
    const f = publicationFixture();

    const failed = runPublish(f, { [failure]: '1' });

    expectContentFreeFailure(f, failed);
    expect(failed.stderr).toContain(
      `label=${label} attempt=1/5 result=fail category=${category}`,
    );
    const commandLog = readFileSync(f.commandLog, 'utf8');
    expect(commandLog.split('\n').filter((line) =>
      line.startsWith('curl ') && line.endsWith(` ${url}`),
    )).toHaveLength(1);
    expect(commandLog).not.toContain('sleep 1\n');
  });

  it('retries public health availability but gives local health one attempt and no sleep', () => {
    const publicFixture = publicationFixture();
    const publicResult = runPublish(publicFixture, {
      RUNTIME_RAIDERS_TEST_FAIL_LABEL: 'public-health',
      RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS: '1',
      RUNTIME_RAIDERS_TEST_FAIL_MODE: 'transport',
    });
    expect(publicResult.status, publicResult.stderr).toBe(0);
    expect(publicResult.stderr).toContain(
      'label=public-health attempt=1/5 result=retry category=request',
    );
    expect(publicResult.stderr).toContain(
      'label=public-health attempt=2/5 result=ok category=complete',
    );
    expect(readFileSync(publicFixture.commandLog, 'utf8').match(/^sleep 1$/gm)).toHaveLength(1);

    const localFixture = publicationFixture();
    const localResult = runPublish(localFixture, {
      RUNTIME_RAIDERS_TEST_FAIL_LABEL: 'local-health',
      RUNTIME_RAIDERS_TEST_FAIL_ATTEMPTS: '5',
      RUNTIME_RAIDERS_TEST_FAIL_MODE: 'status',
    });
    expectContentFreeFailure(localFixture, localResult);
    expect(localResult.stderr).toContain(
      'label=local-health attempt=1/1 result=fail category=status',
    );
    const localLog = readFileSync(localFixture.commandLog, 'utf8');
    expect(localLog.split('\n').filter((line) =>
      line.startsWith('curl ') && line.endsWith(` ${localHealthURL}`),
    )).toHaveLength(1);
    expect(localLog).not.toContain('sleep 1\n');
  });

  it.each([
    ['installer digest', 'RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_INSTALLER_FETCH', 'installer', 'digest', true, 1, 5],
    ['ZIP digest', 'RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_ZIP_FETCH', 'zip', 'digest', true, 1, 5],
    ['checksum digest', 'RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_CHECKSUM_FETCH', 'checksum', 'digest', true, 1, 5],
    ['manifest digest', 'RUNTIME_RAIDERS_TEST_CORRUPT_PUBLIC_MANIFEST_FETCH', 'manifest', 'digest', true, 1, 5],
    ['oversized installer', 'RUNTIME_RAIDERS_TEST_PUBLIC_INSTALLER_OVERSIZED', 'installer', 'size', true, 1, 5],
    ['missing cache-control', 'RUNTIME_RAIDERS_TEST_PUBLIC_ZIP_MISSING_NO_STORE', 'zip', 'cache-control', true, 1, 5],
    ['missing nosniff', 'RUNTIME_RAIDERS_TEST_PUBLIC_CHECKSUM_MISSING_NOSNIFF', 'checksum', 'nosniff', true, 1, 5],
    ['invalid canonical manifest', 'RUNTIME_RAIDERS_TEST_INVALID_CANONICAL_PUBLIC_MANIFEST', 'manifest', 'manifest', true, 1, 5],
    ['public health', 'RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_HEALTH', 'public-health', 'request', true, 5, 5],
    ['local health', 'RUNTIME_RAIDERS_TEST_FAIL_LOCAL_HEALTH', 'local-health', 'request', false, 1, 1],
  ])('restores selection or removes a first selector after %s verification failure', (
    _name,
    failure,
    label,
    category,
    hasPriorSelector,
    expectedAttempt,
    expectedMaxAttempts,
  ) => {
    const priorSha = 'a'.repeat(40);
    const sensitive = 'do-not-log-sensitive-marker';
    const f = publicationFixture();
    if (hasPriorSelector) {
      setPublicationIdentity(f, priorSha, 1);
      expect(runPublish(f).status).toBe(0);
      setPublicationIdentity(f, releaseSha, 2);
    }

    const failed = runPublish(f, {
      [failure]: '1',
      RUNTIME_RAIDERS_TEST_SENSITIVE: sensitive,
    });

    expectContentFreeFailure(f, failed);
    expect(failed.stderr).not.toContain(sensitive);
    expect(failed.stderr.split('\n').filter((line) => line.includes('result=fail'))).toEqual([
      'runtime-raiders-artifacts: verify label=' + label +
        ` attempt=${expectedAttempt}/${expectedMaxAttempts} result=fail category=` + category,
    ]);
    if (hasPriorSelector) {
      expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe('releases/' + priorSha);
    } else {
      expect(existsSync(join(f.artifactRoot, 'current'))).toBe(false);
    }
    expect(releaseBytes(f.artifactRoot, releaseSha).updateManifest).toEqual(
      readFileSync(f.files.updateManifest),
    );
    expectNoTemporaryPublicationPaths(f.artifactRoot);
  });

  it('preserves an out-of-band selector that appears before restoring a prior selector', () => {
    const priorSha = 'a'.repeat(40);
    const outOfBandSelector = `releases/${'c'.repeat(40)}`;
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    expect(runPublish(f).status).toBe(0);
    setPublicationIdentity(f, releaseSha, 2);

    const failed = runPublish(f, {
      RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_MANIFEST_FETCH: '1',
      ...rollbackRaceEnvironment(f, outOfBandSelector),
    });

    expectContentFreeFailure(f, failed);
    expect(readFileSync(f.commandLog, 'utf8')).toContain('rollback-race\n');
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(outOfBandSelector);
    expect(releaseBytes(f.artifactRoot, releaseSha).updateManifest).toEqual(
      readFileSync(f.files.updateManifest),
    );
    expectNoTemporaryPublicationPaths(f.artifactRoot);
  });

  it('preserves an out-of-band selector that appears before removing a first selector', () => {
    const outOfBandSelector = `releases/${'c'.repeat(40)}`;
    const f = publicationFixture();

    const failed = runPublish(f, {
      RUNTIME_RAIDERS_TEST_FAIL_PUBLIC_MANIFEST_FETCH: '1',
      ...rollbackRaceEnvironment(f, outOfBandSelector),
    });

    expectContentFreeFailure(f, failed);
    expect(readFileSync(f.commandLog, 'utf8')).toContain('rollback-race\n');
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(outOfBandSelector);
    expect(releaseBytes(f.artifactRoot, releaseSha).updateManifest).toEqual(
      readFileSync(f.files.updateManifest),
    );
    expectNoTemporaryPublicationPaths(f.artifactRoot);
  });

  it('does not clobber a release directory that appears during the release rename', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    expect(runPublish(f).status).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);

    setPublicationIdentity(f, releaseSha, 2);
    const raced = runPublish(f, { RUNTIME_RAIDERS_TEST_RACE_RELEASE: '1' });

    expectContentFreeFailure(f, raced);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    const racedRelease = join(f.artifactRoot, 'releases', releaseSha);
    expect(readdirSync(racedRelease)).toEqual(['preexisting']);
    expect(readFileSync(join(racedRelease, 'preexisting'), 'utf8')).toBe('preexisting');
  });

  it('automatically releases the lock and permits withdrawal after committed publication', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    setPublicationIdentity(f, priorSha, 1);
    expect(runPublish(f).status).toBe(0);

    setPublicationIdentity(f, releaseSha, 2);
    const published = runPublish(f, { RUNTIME_RAIDERS_TEST_FAIL_LOCK_CLEANUP: '1' });

    expect(published.status, published.stderr).toBe(0);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(lstatSync(join(f.artifactRoot, '.publication.lock')).isFile()).toBe(true);
    const withdrawn = runWithdraw(f);
    expect(withdrawn.status, withdrawn.stderr).toBe(0);
  });

  it('returns nonzero after post-commit output failure and leaves withdrawal available', () => {
    const f = publicationFixture();
    const failed = runPublish(f, {
      BASH_ENV: postCommitBashEnv(f, 'fail-output'),
      RUNTIME_RAIDERS_TEST_FAIL_LOCK_CLEANUP: '1',
    });

    expect(failed.status).not.toBe(0);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    const withdrawn = runWithdraw(f);
    expect(withdrawn.status, withdrawn.stderr).toBe(0);
  });

  it.each(['HUP', 'INT', 'TERM'])(
    'does not return nonzero when %s arrives during post-commit cleanup',
    (signal) => {
      const priorSha = 'a'.repeat(40);
      const f = publicationFixture();
      setPublicationIdentity(f, priorSha, 1);
      expect(runPublish(f).status).toBe(0);

      setPublicationIdentity(f, releaseSha, 2);
      const published = runPublish(f, {
        BASH_ENV: postCommitBashEnv(f, 'signal'),
        RUNTIME_RAIDERS_TEST_POSTCOMMIT_SIGNAL: signal,
        RUNTIME_RAIDERS_TEST_FAIL_LOCK_CLEANUP: '1',
      });

      expect(published.status, published.stderr).toBe(0);
      expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
      const withdrawn = runWithdraw(f);
      expect(withdrawn.status, withdrawn.stderr).toBe(0);
    },
  );

  it.each(['HUP', 'INT', 'TERM'])(
    'returns nonzero and preserves current when %s arrives before commit',
    (signal) => {
      const priorSha = 'a'.repeat(40);
      const f = publicationFixture();
      setPublicationIdentity(f, priorSha, 1);
      expect(runPublish(f).status).toBe(0);
      const priorBytes = releaseBytes(f.artifactRoot, priorSha);

      setPublicationIdentity(f, releaseSha, 2);
      const interrupted = runPublish(f, { RUNTIME_RAIDERS_TEST_PRECOMMIT_SIGNAL: signal });

      expectContentFreeFailure(f, interrupted);
      expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
      expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
      expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(false);
    },
  );

  it('does not alter a damaged existing release or the prior selector', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    const existingPublication = runPublish(f);
    expect(existingPublication.status, existingPublication.stderr).toBe(0);
    setPublicationIdentity(f, priorSha, 2);
    const priorPublication = runPublish(f);
    expect(priorPublication.status, priorPublication.stderr).toBe(0);
    const priorBytes = releaseBytes(f.artifactRoot, priorSha);
    const existingInstaller = join(f.artifactRoot, 'releases', releaseSha, 'install.sh');
    writeFileSync(existingInstaller, 'tampered');

    setPublicationIdentity(f, releaseSha, 3);
    const refused = runPublish(f);

    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).not.toContain(f.root);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(releaseBytes(f.artifactRoot, priorSha)).toEqual(priorBytes);
    expect(readFileSync(existingInstaller, 'utf8')).toBe('tampered');
  });

  it('publishes the canonical v2 quartet atomically with private manifest-backed status', () => {
    const environment = fixture();
    const files = sourceTriplet(environment.artifactRoot);
    const installerDigest = sha256(files.installer);
    const zipDigest = sha256(files.zip);
    const checksumDigest = sha256(files.checksum);
    const updateManifestDigest = sha256(files.updateManifest);
    const expectedOutput = [
      `active_release=${releaseSha}`,
      `release_sequence=${releaseSequence}`,
      `companion_version=${companionVersion}`,
      `update_protocol_version=${updateProtocolVersion}`,
      `installer_sha256=${installerDigest}`,
      `zip_sha256=${zipDigest}`,
      `checksum_sha256=${checksumDigest}`,
      `update_manifest_sha256=${updateManifestDigest}`,
      '',
    ].join('\n');

    const published = runScript(files, environment, 'publish');

    expect(published.status, published.stderr).toBe(0);
    expect(published.stdout).toBe(expectedOutput);
    expect(published.stderr).not.toContain(environment.artifactRoot);
    expect(readlinkSync(join(environment.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);

    const release = join(environment.artifactRoot, 'releases', releaseSha);
    const downloads = join(release, 'downloads');
    const current = join(environment.artifactRoot, 'current');
    expect(readFileSync(join(release, 'install.sh'))).toEqual(readFileSync(files.installer));
    expect(readFileSync(join(current, 'install.sh'))).toEqual(readFileSync(files.installer));
    expect(readFileSync(join(downloads, 'runtime-raiders-agent.zip'))).toEqual(readFileSync(files.zip));
    expect(readFileSync(join(downloads, 'runtime-raiders-agent.zip.sha256'))).toEqual(readFileSync(files.checksum));
    expect(readFileSync(join(downloads, 'runtime-raiders-agent.update.json'))).toEqual(
      readFileSync(files.updateManifest),
    );
    expect(readFileSync(join(current, 'downloads/runtime-raiders-agent.zip'))).toEqual(readFileSync(files.zip));
    expect(readFileSync(join(current, 'downloads/runtime-raiders-agent.zip.sha256'))).toEqual(readFileSync(files.checksum));
    expect(readFileSync(join(current, 'downloads/runtime-raiders-agent.update.json'))).toEqual(
      readFileSync(files.updateManifest),
    );
    expect(existsSync(join(release, 'runtime-raiders-agent.zip'))).toBe(false);
    expect(existsSync(join(release, 'runtime-raiders-agent.zip.sha256'))).toBe(false);
    expect(mode(release)).toBe(0o755);
    expect(mode(join(release, 'install.sh'))).toBe(0o644);
    expect(lstatSync(downloads).isDirectory()).toBe(true);
    expect(lstatSync(downloads).isSymbolicLink()).toBe(false);
    expect(mode(downloads)).toBe(0o755);
    expect(mode(join(downloads, 'runtime-raiders-agent.zip'))).toBe(0o644);
    expect(mode(join(downloads, 'runtime-raiders-agent.zip.sha256'))).toBe(0o644);
    expect(mode(join(downloads, 'runtime-raiders-agent.update.json'))).toBe(0o644);
    expect(mode(join(release, '.release-manifest'))).toBe(0o600);
    expect(readdirSync(release).sort()).toEqual(['.release-manifest', 'downloads', 'install.sh']);
    expect(readdirSync(downloads).sort()).toEqual([
      'runtime-raiders-agent.update.json',
      'runtime-raiders-agent.zip',
      'runtime-raiders-agent.zip.sha256',
    ]);
    expect(readFileSync(join(release, '.release-manifest'), 'utf8')).toBe([
      'version=2',
      `release_sha=${releaseSha}`,
      `release_sequence=${releaseSequence}`,
      `companion_version=${companionVersion}`,
      `update_protocol_version=${updateProtocolVersion}`,
      `installer_sha256=${installerDigest}`,
      `zip_sha256=${zipDigest}`,
      `checksum_sha256=${checksumDigest}`,
      `update_manifest_sha256=${updateManifestDigest}`,
      '',
    ].join('\n'));

    const commands = readFileSync(environment.commandLog, 'utf8');
    expect(commands.match(/install -d -o root -g root -m 0755/g)).toHaveLength(2);
    expect(commands.match(/install -o root -g root -m 0644/g)).toHaveLength(4);
    expect(commands.match(/^curl /gm)).toHaveLength(6);
    expect(commands).not.toContain('--location');
    expect(commands).toContain('chown root:root');

    const status = runScript(files, environment, 'status');
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(expectedOutput);
    expect(status.stderr).toBe('');
  });

  it('publishes the rendered production installer with legitimate runtime URL references', () => {
    const f = publicationFixture();
    const renderedInstaller = readFileSync(INSTALLER_TEMPLATE, 'utf8')
      .replaceAll('__RUNTIME_RAIDERS_TEAM_ID__', 'ABCDE12345');
    writeFileSync(f.files.installer, renderedInstaller);

    const published = runPublish(f);

    expect(published.status, published.stderr).toBe(0);
    expect(readFileSync(
      join(f.artifactRoot, 'releases', releaseSha, 'install.sh'),
      'utf8',
    )).toBe(renderedInstaller);
  });

  it('reports unpublished without exposing artifact content', () => {
    const environment = fixture();
    const files = sourceTriplet(environment.artifactRoot);

    const status = runScript(files, environment, 'status');

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe('unpublished\n');
    expect(status.stderr).toBe('');
  });

  it('rejects an out-of-root source reached through a symlinked ancestor', () => {
    const environment = fixture();
    const files = sourceTriplet(environment.root);
    symlinkSync(environment.root, join(environment.artifactRoot, 'linked-source'), 'dir');
    const linkedFiles = {
      ...files,
      source: join(environment.artifactRoot, 'linked-source', 'source'),
    };

    const published = runScript(linkedFiles, environment, 'publish');

    expect(published.status).not.toBe(0);
    expect(published.stdout).toBe('');
    expect(published.stderr).toContain('source must resolve beneath artifact root');
    expect(existsSync(join(environment.artifactRoot, 'current'))).toBe(false);
  });
});

describe('Runtime Raiders artifact status validation', () => {
  it('preserves the exact private v1 manifest layout and status output', () => {
    const f = publicationFixture();
    const expectedStatus = createSelectedV1Release(f, releaseSha);

    const status = runStatus(f);

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toBe(expectedStatus);
    expect(status.stderr).toBe('');
    expect(readdirSync(join(f.artifactRoot, 'releases', releaseSha, 'downloads')).sort()).toEqual([
      'runtime-raiders-agent.zip',
      'runtime-raiders-agent.zip.sha256',
    ]);
  });

  it.each([
    ['absolute target', `/releases/${releaseSha}`],
    ['parent traversal', `../releases/${releaseSha}`],
    ['uppercase SHA', `releases/${releaseSha.toUpperCase()}`],
    ['nested target', `releases/nested/${releaseSha}`],
  ])('rejects a malformed current selector: %s', (_name, target) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');
    unlinkSync(current);
    symlinkSync(target, current);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['regular file', (current: string) => writeFileSync(current, 'unsafe-selector')],
    ['directory', (current: string) => mkdirSync(current)],
  ])('rejects current when it is an unsafe %s', (_name, createUnsafeSelector) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');
    unlinkSync(current);
    createUnsafeSelector(current);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it('rejects a current selector not owned by root', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const status = runStatus(f, { RUNTIME_RAIDERS_TEST_SELECTOR_OWNER: '1000:1000' });

    expectContentFreeFailure(f, status);
  });

  it('rejects a corrupted release manifest', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    appendFileSync(join(f.artifactRoot, 'releases', releaseSha, '.release-manifest'), 'extra=true\n');

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['file', (release: string) => writeFileSync(join(release, 'provider-user-secret.txt'), 'private-extra')],
    ['directory', (release: string) => mkdirSync(join(release, 'provider-user-secret-dir'))],
  ])('rejects an unexpected %s in an immutable release without naming it', (_name, addEntry) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const release = join(f.artifactRoot, 'releases', releaseSha);
    addEntry(release);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
    expect(status.stderr).not.toContain('provider-user-secret');
    expect(status.stderr).not.toContain('private-extra');
  });

  it.each([
    ['file', (downloads: string) => writeFileSync(join(downloads, 'provider-user-secret.txt'), 'private-extra')],
    ['directory', (downloads: string) => mkdirSync(join(downloads, 'provider-user-secret-dir'))],
  ])('rejects an unexpected %s in downloads without naming it', (_name, addEntry) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const downloads = join(f.artifactRoot, 'releases', releaseSha, 'downloads');
    addEntry(downloads);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
    expect(status.stderr).not.toContain('provider-user-secret');
    expect(status.stderr).not.toContain('private-extra');
  });

  it.each([
    ['release root', (release: string) => join(release, 'provider-user-secret.txt')],
    ['downloads', (release: string) => join(release, 'downloads', 'provider-user-secret.txt')],
  ])('refuses publication when a stored immutable release contains an unexpected entry in %s', (_name, extraPath) => {
    const priorSha = 'a'.repeat(40);
    const nextSha = 'c'.repeat(40);
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    setPublicationIdentity(f, priorSha, 2);
    expect(runPublish(f).status).toBe(0);
    const existingRelease = join(f.artifactRoot, 'releases', releaseSha);
    const extra = extraPath(existingRelease);
    writeFileSync(extra, 'private-extra');

    setPublicationIdentity(f, nextSha, 3);
    const refused = runPublish(f);

    expectContentFreeFailure(f, refused);
    expect(refused.stderr).not.toContain('provider-user-secret');
    expect(refused.stderr).not.toContain('private-extra');
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${priorSha}`);
    expect(readFileSync(extra, 'utf8')).toBe('private-extra');
  });

  it.each([
    ['missing', (f: PublicationFixture, downloads: string) => rmSync(downloads, { recursive: true })],
    ['regular file', (f: PublicationFixture, downloads: string) => {
      rmSync(downloads, { recursive: true });
      writeFileSync(downloads, 'wrong-type');
    }],
    ['symlink', (f: PublicationFixture, downloads: string) => {
      rmSync(downloads, { recursive: true });
      const target = join(f.artifactRoot, 'downloads-symlink-target');
      mkdirSync(target);
      symlinkSync(target, downloads, 'dir');
    }],
  ])('rejects a %s downloads directory', (_name, corrupt) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const downloads = join(f.artifactRoot, 'releases', releaseSha, 'downloads');
    corrupt(f, downloads);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['ZIP', 'runtime-raiders-agent.zip'],
    ['checksum', 'runtime-raiders-agent.zip.sha256'],
    ['update manifest', 'runtime-raiders-agent.update.json'],
  ])('rejects a symlinked nested %s', (_name, filename) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const file = join(f.artifactRoot, 'releases', releaseSha, 'downloads', filename);
    unlinkSync(file);
    symlinkSync(f.files.installer, file);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['release directory', '.', 0o700],
    ['downloads directory', 'downloads', 0o700],
    ['installer', 'install.sh', 0o600],
    ['ZIP', 'downloads/runtime-raiders-agent.zip', 0o600],
    ['checksum', 'downloads/runtime-raiders-agent.zip.sha256', 0o600],
    ['update manifest', 'downloads/runtime-raiders-agent.update.json', 0o600],
    ['manifest', '.release-manifest', 0o644],
  ])('rejects the wrong mode on the %s', (_name, relativePath, wrongMode) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    chmodSync(join(f.artifactRoot, 'releases', releaseSha, relativePath), wrongMode);

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['installer', 'install.sh'],
    ['ZIP', 'downloads/runtime-raiders-agent.zip'],
    ['checksum', 'downloads/runtime-raiders-agent.zip.sha256'],
    ['update manifest', 'downloads/runtime-raiders-agent.update.json'],
    ['manifest', '.release-manifest'],
  ])('rejects a release missing its %s', (_name, relativePath) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    unlinkSync(join(f.artifactRoot, 'releases', releaseSha, relativePath));

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });

  it.each([
    ['installer', 'install.sh'],
    ['ZIP', 'downloads/runtime-raiders-agent.zip'],
    ['checksum', 'downloads/runtime-raiders-agent.zip.sha256'],
    ['update manifest', 'downloads/runtime-raiders-agent.update.json'],
  ])('rejects a calculated %s digest mismatch', (_name, relativePath) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    writeFileSync(join(f.artifactRoot, 'releases', releaseSha, relativePath), 'damaged after publication');

    const status = runStatus(f);

    expectContentFreeFailure(f, status);
  });
});

describe('Runtime Raiders exact-SHA withdrawal', () => {
  it('refuses withdrawal of a SHA other than the exact selected release', () => {
    const priorSha = 'a'.repeat(40);
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const wrong = runWithdraw(f, priorSha);

    expectContentFreeFailure(f, wrong);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });

  it('withdraws the exact selected SHA without validating damaged release content', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');
    const releaseDirectory = join(f.artifactRoot, 'releases', releaseSha);
    writeFileSync(join(releaseDirectory, 'downloads', 'runtime-raiders-agent.zip'), 'damaged after publication');

    const withdrawn = runWithdraw(f);

    expect(withdrawn.status, withdrawn.stderr).toBe(0);
    expect(existsSync(current)).toBe(false);
    expect(existsSync(releaseDirectory)).toBe(true);
    expect(withdrawn.stdout).toBe(`withdrawn_release=${releaseSha}\n`);
    expect(withdrawn.stderr).toBe('');
  });

  it('leaves current selected if the withdrawal rename fails', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const failed = runWithdraw(f, releaseSha, { RUNTIME_RAIDERS_TEST_FAIL_WITHDRAW_MV: '1' });

    expectContentFreeFailure(f, failed);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(readdirSync(f.artifactRoot).some((name) => name.startsWith('.withdrawn.'))).toBe(false);
  });

  it('keeps downloads withdrawn and returns nonzero if tombstone unlink fails', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);
    const current = join(f.artifactRoot, 'current');

    const failed = runWithdraw(f, releaseSha, { RUNTIME_RAIDERS_TEST_FAIL_UNLINK: '1' });

    expectContentFreeFailure(f, failed);
    expect(existsSync(current)).toBe(false);
    expect(readdirSync(f.artifactRoot).filter((name) => name.startsWith('.withdrawn.'))).toHaveLength(1);
    expect(existsSync(join(f.artifactRoot, 'releases', releaseSha))).toBe(true);
  });

  it('refuses withdrawal while the fd lock is busy without changing current', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const locked = runWithdraw(f, releaseSha, { RUNTIME_RAIDERS_TEST_FLOCK_BUSY: '1' });

    expectContentFreeFailure(f, locked);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
    expect(readFileSync(f.commandLog, 'utf8')).toContain('flock -n 9');
  });

  it('refuses withdrawal when current is not owned by root', () => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const refused = runWithdraw(f, releaseSha, {
      RUNTIME_RAIDERS_TEST_SELECTOR_OWNER: '1000:1000',
    });

    expectContentFreeFailure(f, refused);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });

  it.each([
    ['withdraw'],
    ['withdraw', '--release-sha'],
    ['withdraw', '--release-sha', releaseSha.toUpperCase()],
    ['withdraw', '--release-sha', releaseSha, 'extra'],
    ['withdraw', '--release-sha', releaseSha, '--release-sha', releaseSha],
  ])('rejects malformed withdrawal arguments: %s', (...args) => {
    const f = publicationFixture();
    expect(runPublish(f).status).toBe(0);

    const malformed = run(f, args);

    expectContentFreeFailure(f, malformed);
    expect(readlinkSync(join(f.artifactRoot, 'current'))).toBe(`releases/${releaseSha}`);
  });
});
