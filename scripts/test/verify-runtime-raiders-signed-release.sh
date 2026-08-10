#!/bin/bash

set -euo pipefail

usage() {
  echo "usage: $0 /absolute/path/to/local-unpublished-quartet" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
case "$1" in
  http://*|https://*) echo "Gate 2 refuses URLs" >&2; exit 64 ;;
esac
[ -d "$1" ] && [ ! -L "$1" ] || usage

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
QUARTET="$(cd "$1" && pwd -P)"
OWNER="$(id -u)"
: "${RUNTIME_RAIDERS_CODESIGN_IDENTITY:?Gate 2 requires an explicitly authorized Developer ID identity}"
SIGNING_IDENTITY="$RUNTIME_RAIDERS_CODESIGN_IDENTITY"
unset RUNTIME_RAIDERS_CODESIGN_IDENTITY RUNTIME_RAIDERS_NOTARY_PROFILE
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID AC_PASSWORD
. "$ROOT/scripts/test/runtime-raiders-gate-safety.sh"

gate_root="$(mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-gate2.XXXXXX")"
gate_root="$(cd "$gate_root" && pwd -P)"
gate_parent="$(cd "${gate_root%/*}" && pwd -P)"
chmod 700 "$gate_root"
mkdir -m 700 "$gate_root/processes"
export GATE_PROCESS_ROOT="$gate_root/processes"
lease_fd_open=0

cleanup() {
  status=$?
  case "$gate_root" in
    "$gate_parent"/runtime-raiders-gate2.*) ;;
    *) exit 1 ;;
  esac
  if [ -d "$gate_root" ] && [ ! -L "$gate_root" ] &&
     [ "$(/usr/bin/stat -f '%u' "$gate_root")" = "$OWNER" ]; then
    if [ "$lease_fd_open" -eq 1 ]; then exec 9>&- || status=1; lease_fd_open=0; fi
    gate_process_stop_all || status=1
    /bin/rm -rf -- "$gate_root"
  else
    status=1
  fi
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

validate_local_regular() {
  local file="$1"
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(/usr/bin/stat -f '%u' "$file")" = "$OWNER" ] || return 1
  [ "$(/usr/bin/stat -f '%l' "$file")" = 1 ] || return 1
  local mode
  mode="$(/usr/bin/stat -f '%Lp' "$file")"
  (( (8#$mode & 8#022) == 0 ))
}

[ "$(/usr/bin/stat -f '%u' "$QUARTET")" = "$OWNER" ] || {
  echo "Gate 2 refuses an unowned quartet directory" >&2
  exit 1
}

INSTALLER="$QUARTET/install.sh"
ARCHIVE="$QUARTET/runtime-raiders-agent.zip"
CHECKSUM="$QUARTET/runtime-raiders-agent.zip.sha256"
MANIFEST="$QUARTET/runtime-raiders-agent.update.json"
[ -f "$INSTALLER" ] && [ ! -L "$INSTALLER" ] || { echo "unsafe install.sh" >&2; exit 1; }
for file in "$INSTALLER" "$ARCHIVE" "$CHECKSUM" "$MANIFEST"; do
  validate_local_regular "$file" || { echo "Gate 2 refuses unsafe quartet member: $file" >&2; exit 1; }
done
[ -x "$INSTALLER" ] || { echo "Gate 2 requires an executable rendered installer" >&2; exit 1; }
[ "$(find "$QUARTET" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 4 ] || {
  echo "Gate 2 requires exactly the signed quartet" >&2
  exit 1
}

expected_checksum="$(awk 'NR == 1 && NF == 2 && $2 == "runtime-raiders-agent.zip" { print $1 }' "$CHECKSUM")"
case "$expected_checksum" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ "${#expected_checksum}" -eq 64 ] && [ "$(wc -l < "$CHECKSUM" | tr -d ' ')" -eq 1 ] || exit 1
actual_checksum="$(/usr/bin/shasum -a 256 "$ARCHIVE" | awk 'NR == 1 { print $1 }')"
[ "$actual_checksum" = "$expected_checksum" ] || { echo "Gate 2 checksum mismatch" >&2; exit 1; }

manifest_fields="$(node - "$MANIFEST" "$actual_checksum" <<'NODE'
const fs = require('node:fs');
const [path, digest] = process.argv.slice(2);
const source = fs.readFileSync(path, 'utf8');
let value;
try { value = JSON.parse(source); } catch { process.exit(1); }
const keys = ['companion_version', 'manifest_version', 'release_sequence', 'release_sha', 'update_protocol_version', 'zip_sha256', 'zip_url'];
if (!value || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) process.exit(1);
if (value.manifest_version !== 1 || value.update_protocol_version !== 2) process.exit(1);
if (!Number.isSafeInteger(value.release_sequence) || value.release_sequence < 2) process.exit(1);
if (!/^\d+\.\d+\.\d+$/.test(value.companion_version)) process.exit(1);
if (!/^[0-9a-f]{40}$/.test(value.release_sha)) process.exit(1);
if (value.zip_sha256 !== digest || value.zip_url !== 'https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip') process.exit(1);
const canonical = JSON.stringify({
  companion_version: value.companion_version,
  manifest_version: 1,
  release_sequence: value.release_sequence,
  release_sha: value.release_sha,
  update_protocol_version: 2,
  zip_sha256: value.zip_sha256,
  zip_url: value.zip_url,
}) + '\n';
if (source !== canonical) process.exit(1);
process.stdout.write([value.release_sequence, value.release_sha, value.companion_version, value.update_protocol_version].join('\t'));
NODE
)" || { echo "Gate 2 manifest is invalid" >&2; exit 1; }
IFS=$'\t' read -r RELEASE_SEQUENCE RELEASE_SHA COMPANION_VERSION UPDATE_PROTOCOL_VERSION <<<"$manifest_fields"
[ "$UPDATE_PROTOCOL_VERSION" = 2 ] || exit 1
gate_verify_reviewed_source "$ROOT" "$RELEASE_SHA" \
  companion/packaging/install.sh \
  scripts/release/render-runtime-raiders-installer.sh \
  scripts/test/runtime-raiders-gate-safety.sh || {
  echo "Gate 2 requires the clean reviewed release source at the signed SHA" >&2
  exit 1
}

scratch="$gate_root/validator-build"
for architecture in arm64 x86_64; do
  swift build --disable-sandbox --package-path "$ROOT/companion" --scratch-path "$scratch" \
    --configuration release --arch "$architecture" --disable-automatic-resolution --skip-update \
    --product runtime-raiders-release-validator >/dev/null
done
validator_bin="$gate_root/runtime-raiders-release-validator"
/usr/bin/lipo -create \
  "$scratch/arm64-apple-macosx/release/runtime-raiders-release-validator" \
  "$scratch/x86_64-apple-macosx/release/runtime-raiders-release-validator" \
  -output "$validator_bin"
/usr/bin/lipo -verify_arch arm64 x86_64 "$validator_bin"
[ -x "$validator_bin" ] || exit 1
"$validator_bin" "$ARCHIVE"

extract_root="$gate_root/extracted"
mkdir -m 700 "$extract_root"
/usr/bin/ditto -x -k "$ARCHIVE" "$extract_root"
release_container="$extract_root/Runtime Raiders Release"
agent_app="$release_container/Runtime Raiders Agent.app"
launcher_app="$release_container/Runtime Raiders Launcher.app"
agent_executable="$agent_app/Contents/MacOS/runtime-raiders-agent"
launcher_executable="$launcher_app/Contents/MacOS/runtime-raiders-launcher"
[ -d "$agent_app" ] && [ ! -L "$agent_app" ] && [ -x "$agent_executable" ] || exit 1
[ -d "$launcher_app" ] && [ ! -L "$launcher_app" ] && [ -x "$launcher_executable" ] || exit 1

TEAM_ID="$(/usr/bin/codesign -dv --verbose=4 "$agent_app" 2>&1 | awk -F= '$1 == "TeamIdentifier" { print $2 }')"
case "$TEAM_ID" in ''|*[!A-Z0-9]*) exit 1 ;; esac
[ "${#TEAM_ID}" -eq 10 ] || exit 1
launcher_team="$(/usr/bin/codesign -dv --verbose=4 "$launcher_app" 2>&1 | awk -F= '$1 == "TeamIdentifier" { print $2 }')"
[ "$launcher_team" = "$TEAM_ID" ] || exit 1
AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'
LAUNCHER_REQUIREMENT='identifier "com.redlattice.runtime-raiders-launcher" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

/usr/bin/codesign --verify --strict --deep --all-architectures -R="$AGENT_REQUIREMENT" "$agent_app"
/usr/bin/codesign --verify --strict --deep --all-architectures -R="$LAUNCHER_REQUIREMENT" "$launcher_app"
/usr/bin/lipo -verify_arch arm64 x86_64 "$agent_executable"
/usr/bin/lipo -verify_arch arm64 x86_64 "$launcher_executable"
/usr/sbin/spctl --assess --type execute --verbose=4 "$agent_app"
/usr/sbin/spctl --assess --type execute --verbose=4 "$launcher_app"
/usr/bin/xcrun stapler validate "$agent_app"
/usr/bin/xcrun stapler validate "$launcher_app"
"$validator_bin" "$ARCHIVE" "$extract_root" "$RELEASE_SEQUENCE" "$RELEASE_SHA" \
  "$COMPANION_VERSION" "$UPDATE_PROTOCOL_VERSION" "$TEAM_ID"

SIGNED_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$agent_app/Contents/Info.plist")"
SIGNED_SEQUENCE="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$agent_app/Contents/Info.plist")"
SIGNED_SHA="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$agent_app/Contents/Info.plist")"
SIGNED_PROTOCOL="$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$agent_app/Contents/Info.plist")"
[ "$SIGNED_VERSION" = "$COMPANION_VERSION" ] && [ "$SIGNED_SEQUENCE" = "$RELEASE_SEQUENCE" ] &&
  [ "$SIGNED_SHA" = "$RELEASE_SHA" ] && [ "$SIGNED_PROTOCOL" = "$UPDATE_PROTOCOL_VERSION" ] || exit 1
expected_installer="$gate_root/expected-install.sh"
gate_verify_installer_binding \
  "$INSTALLER" \
  "$ROOT/companion/packaging/install.sh" \
  "$ROOT/scripts/release/render-runtime-raiders-installer.sh" \
  "$validator_bin" \
  "$TEAM_ID" \
  "$SIGNED_VERSION" \
  "$SIGNED_SEQUENCE" \
  "$SIGNED_SHA" \
  "$SIGNED_PROTOCOL" \
  "$expected_installer" || {
  echo "Gate 2 installer is not the exact reviewed deterministic rendering" >&2
  exit 1
}

write_enrollment() {
  local home="$1" state="$1/Library/Application Support/Runtime Raiders/state"
  mkdir -p "$state" "$1/Library/Application Support/Runtime Raiders/outbox"
  chmod 700 "$1/Library" "$1/Library/Application Support" "$1/Library/Application Support/Runtime Raiders" "$state" "$1/Library/Application Support/Runtime Raiders/outbox"
  printf '%s\n' '{"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","server_url":"https://raiders.redlattice.com","cutover_at":1700000000000,"enabled_surfaces":["codex_desktop","codex_cli"]}' > "$state/enrollment.json"
  printf '%s\n' '{"enabled":false,"files":{},"version":1}' > "$state/collector-state.json"
  chmod 600 "$state/enrollment.json" "$state/collector-state.json"
}

fixture_home="$gate_root/launcher-fixtures/home"
support="$fixture_home/Library/Application Support/Runtime Raiders"
mkdir -p "$support/launcher" "$support/releases" "$support/installation" "$support/state" "$support/outbox"
chmod 700 "$fixture_home" "$fixture_home/Library" "$fixture_home/Library/Application Support" "$support" "$support/launcher" "$support/releases" "$support/installation" "$support/state" "$support/outbox"
write_enrollment "$fixture_home"
/usr/bin/ditto "$launcher_app" "$support/launcher/Runtime Raiders Launcher.app"
installed_launcher="$support/launcher/Runtime Raiders Launcher.app/Contents/MacOS/runtime-raiders-launcher"

OLDER_SEQUENCE=$((RELEASE_SEQUENCE - 1))
NEWER_SEQUENCE=$((RELEASE_SEQUENCE + 1))
OLDER_SHA='1111111111111111111111111111111111111111'
NEWER_SHA='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
[ "$OLDER_SHA" != "$RELEASE_SHA" ] && [ "$NEWER_SHA" != "$RELEASE_SHA" ] || exit 1

make_agent_fixture() {
  local sequence="$1" sha="$2" version="$3"
  local directory="$support/releases/sequence-$sequence-$sha"
  local application="$directory/Runtime Raiders Agent.app"
  mkdir "$directory"
  chmod 700 "$directory"
  /usr/bin/ditto "$agent_app" "$application"
  /usr/bin/plutil -replace CFBundleShortVersionString -string "$version" "$application/Contents/Info.plist"
  /usr/bin/plutil -replace RuntimeRaidersReleaseSequence -integer "$sequence" "$application/Contents/Info.plist"
  /usr/bin/plutil -replace RuntimeRaidersReleaseSHA -string "$sha" "$application/Contents/Info.plist"
  /usr/bin/plutil -replace RuntimeRaidersUpdateProtocolVersion -integer 2 "$application/Contents/Info.plist"
  /usr/bin/codesign --force --options runtime --timestamp=none --sign "$SIGNING_IDENTITY" "$application"
  /usr/bin/codesign --verify --strict --all-architectures -R="$AGENT_REQUIREMENT" "$application"
}

make_agent_fixture "$OLDER_SEQUENCE" "$OLDER_SHA" '0.2.9'
mkdir "$support/releases/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"
chmod 700 "$support/releases/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"
/usr/bin/ditto "$agent_app" "$support/releases/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA/Runtime Raiders Agent.app"
make_agent_fixture "$NEWER_SEQUENCE" "$NEWER_SHA" '0.3.1'

ref_json() {
  printf '{"release_sequence":%s,"release_sha":"%s","companion_version":"%s","update_protocol_version":2}' "$1" "$2" "$3"
}

write_state() {
  local generation="$1" active="$2" fallback="$3" trial="$4"
  local path="$support/installation/release-state.json"
  printf '{"schema_version":1,"generation":%s,"active":%s,"fallback":%s,"trial":%s}\n' "$generation" "$active" "$fallback" "$trial" > "$path"
  chmod 600 "$path"
}

run_launcher() {
  gate_run_without_release_credentials env HOME="$fixture_home" CFFIXED_USER_HOME="$fixture_home" \
    "$installed_launcher" "$@"
}

expect_launcher_failure() {
  local label="$1"
  shift
  echo "$label"
  if run_launcher "$@" >/dev/null 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
}

active_ref="$(ref_json "$RELEASE_SEQUENCE" "$RELEASE_SHA" "$COMPANION_VERSION")"
older_ref="$(ref_json "$OLDER_SEQUENCE" "$OLDER_SHA" '0.2.9')"
newer_ref="$(ref_json "$NEWER_SEQUENCE" "$NEWER_SHA" '0.3.1')"

echo launcher-active
write_state 1 "$active_ref" null null
active_status="$(run_launcher status)"
printf '%s' "$active_status" | grep -F "\"installedReleaseSequence\":$RELEASE_SEQUENCE" >/dev/null

echo launcher-fallback
write_state 2 "$active_ref" "$older_ref" null
fallback_status="$(run_launcher status)"
printf '%s' "$fallback_status" | grep -F "\"installedReleaseSequence\":$RELEASE_SEQUENCE" >/dev/null

echo launcher-missing-state
rm "$support/installation/release-state.json"
expect_launcher_failure launcher-missing-state status

echo launcher-malformed-state
printf '%s\n' '{"schema_version":1}' > "$support/installation/release-state.json"
chmod 600 "$support/installation/release-state.json"
expect_launcher_failure launcher-malformed-state status

echo launcher-unsafe-mode
write_state 1 "$active_ref" null null
chmod 644 "$support/installation/release-state.json"
expect_launcher_failure launcher-unsafe-mode status

echo launcher-symlink-state
rm "$support/installation/release-state.json"
printf '{"schema_version":1}\n' > "$support/installation/symlink-target.json"
chmod 600 "$support/installation/symlink-target.json"
ln -s "$support/installation/symlink-target.json" "$support/installation/release-state.json"
expect_launcher_failure launcher-symlink-state status
rm "$support/installation/release-state.json" "$support/installation/symlink-target.json"

echo launcher-identity-mismatch
MISMATCH_SHA='2222222222222222222222222222222222222222'
mkdir "$support/releases/sequence-$RELEASE_SEQUENCE-$MISMATCH_SHA"
chmod 700 "$support/releases/sequence-$RELEASE_SEQUENCE-$MISMATCH_SHA"
/usr/bin/ditto "$agent_app" "$support/releases/sequence-$RELEASE_SEQUENCE-$MISMATCH_SHA/Runtime Raiders Agent.app"
mismatch_ref="$(ref_json "$RELEASE_SEQUENCE" "$MISMATCH_SHA" "$COMPANION_VERSION")"
write_state 1 "$mismatch_ref" null null
expect_launcher_failure launcher-identity-mismatch status

echo launcher-held-trial
write_state 3 "$active_ref" "$older_ref" "$newer_ref"
lease_fifo="$gate_root/launcher-fixtures/lease.fifo"
lease_ready="$gate_root/launcher-fixtures/lease.ready"
mkfifo "$lease_fifo"
exec 9<>"$lease_fifo"
lease_fd_open=1
current_agent="$support/releases/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent"
gate_run_without_release_credentials env HOME="$fixture_home" CFFIXED_USER_HOME="$fixture_home" \
  "$current_agent" __runtime-raiders-installer-lease <"$lease_fifo" >"$lease_ready" &
lease_pid=$!
lease_record="$(gate_process_capture held-lease "$lease_pid" "$current_agent")" || exit 1
for _ in $(seq 1 40); do grep -F -x 'runtime-raiders-installer-lease-ready' "$lease_ready" >/dev/null 2>&1 && break; sleep 0.1; done
grep -F -x 'runtime-raiders-installer-lease-ready' "$lease_ready" >/dev/null
gate_run_without_release_credentials env HOME="$fixture_home" CFFIXED_USER_HOME="$fixture_home" \
  "$installed_launcher" daemon >"$gate_root/launcher-fixtures/trial.log" 2>&1 &
trial_pid=$!
trial_record="$(gate_process_capture held-trial "$trial_pid" "$installed_launcher" \
  "$support/releases/sequence-$NEWER_SEQUENCE-$NEWER_SHA/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent")" || exit 1
for _ in $(seq 1 80); do
  [ -S "$support/agent.sock" ] && break
  gate_process_validate_record "$trial_record" || break
  sleep 0.1
done
[ -S "$support/agent.sock" ] || { echo "held trial did not become ready" >&2; exit 1; }
trial_status="$(run_launcher status)"
printf '%s' "$trial_status" | grep -F "\"installedReleaseSequence\":$NEWER_SEQUENCE" >/dev/null
gate_process_stop_record "$trial_record"
exec 9>&-
lease_fd_open=0
gate_process_stop_record "$lease_record"

fake_bin="$gate_root/fakes"
mkdir -m 700 "$fake_bin"
/bin/cp /usr/bin/sandbox-exec "$fake_bin/runtime-raiders-network-denied"
chmod 700 "$fake_bin/runtime-raiders-network-denied"
cat > "$fake_bin/curl" <<'FAKE_NETWORK'
#!/bin/sh
set -eu
[ "${RUNTIME_RAIDERS_GATE2_FAKE_NETWORK:-}" = 1 ] || exit 97
output=''; status=0; last=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2;;
    -w) status=1; shift 2;;
    --data-binary) cat >/dev/null; shift 2;;
    *) last="$1"; shift;;
  esac
done
case "$last" in
  */runtime-raiders-agent.zip) cp "$RUNTIME_RAIDERS_GATE2_ARCHIVE" "$output";;
  */runtime-raiders-agent.zip.sha256) cp "$RUNTIME_RAIDERS_GATE2_CHECKSUM" "$output";;
  *) exit 98;;
esac
[ "$status" -eq 0 ] || printf 200
FAKE_NETWORK
chmod 700 "$fake_bin/curl"

cat > "$fake_bin/launchctl" <<'FAKE_LAUNCHD'
#!/bin/bash
set -euo pipefail
[ "${RUNTIME_RAIDERS_GATE2_FAKE_LAUNCHD:-}" = 1 ] || exit 97
. "$RUNTIME_RAIDERS_GATE2_SAFETY_LIBRARY"
record="$GATE_PROCESS_ROOT/fake-launchd"
case "$1" in
  print)
    if [ -d "$record" ] && gate_process_validate_record "$record"; then exit 0; fi
    printf 'Could not find service\n' >&2
    exit 113;;
  bootout)
    [ ! -d "$record" ] || gate_process_stop_record "$record"
    exit 0;;
  bootstrap)
    plist=''; for value in "$@"; do plist="$value"; done
    program="$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$plist")"
    argument="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$plist")"
    transition="$program"
    case "$program" in
      *'/Runtime Raiders Launcher.app/Contents/MacOS/runtime-raiders-launcher')
        support="${program%%/launcher/Runtime Raiders Launcher.app/Contents/MacOS/runtime-raiders-launcher}"
        transition="$(find "$support/releases" -type f -path '*/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent' -print)"
        [ "$(printf '%s\n' "$transition" | awk 'NF { count += 1 } END { print count + 0 }')" -eq 1 ] || exit 97
        ;;
    esac
    gate_run_without_release_credentials /usr/bin/nohup "$RUNTIME_RAIDERS_GATE2_NETWORK_SANDBOX" \
      -p '(version 1) (allow default) (deny network-outbound)' "$program" "$argument" \
      >"$HOME/.runtime-raiders-gate2-daemon.log" 2>&1 </dev/null &
    pid=$!
    captured=0
    for _ in $(seq 1 40); do
      if gate_process_capture fake-launchd "$pid" "$RUNTIME_RAIDERS_GATE2_NETWORK_SANDBOX" "$transition" >/dev/null; then
        captured=1
        break
      fi
      sleep 0.05
    done
    [ "$captured" -eq 1 ] || exit 97
    exit 0;;
  kickstart) exit 0;;
  *) exit 64;;
esac
FAKE_LAUNCHD
chmod 700 "$fake_bin/launchctl"

gate_env() {
  local home="$1"
  shift
  gate_run_without_release_credentials env HOME="$home" CFFIXED_USER_HOME="$home" PATH="$fake_bin:/usr/bin:/bin" \
    RUNTIME_RAIDERS_GATE2_FAKE_NETWORK=1 RUNTIME_RAIDERS_GATE2_FAKE_LAUNCHD=1 \
    RUNTIME_RAIDERS_GATE2_ARCHIVE="$ARCHIVE" RUNTIME_RAIDERS_GATE2_CHECKSUM="$CHECKSUM" \
    RUNTIME_RAIDERS_GATE2_SAFETY_LIBRARY="$ROOT/scripts/test/runtime-raiders-gate-safety.sh" \
    RUNTIME_RAIDERS_GATE2_NETWORK_SANDBOX="$fake_bin/runtime-raiders-network-denied" \
    GATE_PROCESS_ROOT="$GATE_PROCESS_ROOT" \
    "$@"
}

fresh_home="$gate_root/installer-fresh/home"
mkdir -p "$fresh_home/Library/Application Support/Runtime Raiders"
chmod 700 "$gate_root/installer-fresh" "$fresh_home" "$fresh_home/Library" "$fresh_home/Library/Application Support" "$fresh_home/Library/Application Support/Runtime Raiders"
write_enrollment "$fresh_home"
gate_env "$fresh_home" /bin/sh "$INSTALLER"
[ -f "$fresh_home/Library/Application Support/Runtime Raiders/installation/release-state.json" ] || exit 1
[ -x "$fresh_home/Library/Application Support/Runtime Raiders/launcher/Runtime Raiders Launcher.app/Contents/MacOS/runtime-raiders-launcher" ] || exit 1
gate_env "$fresh_home" "$fake_bin/launchctl" bootout "gui/$OWNER/com.redlattice.runtime-raiders-agent"

legacy_seed="$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app"
[ -d "$legacy_seed" ] && [ ! -L "$legacy_seed" ] || {
  echo "Gate 2 requires the installed-off sequence-8 app as a read-only migration seed" >&2
  exit 1
}
[ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$legacy_seed/Contents/Info.plist")" = 8 ] || exit 1
[ "$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$legacy_seed/Contents/Info.plist")" = dec88d4f6ff600f2be92bed3b12dcfce85f84a51 ] || exit 1
/usr/bin/codesign --verify --strict --all-architectures -R="$AGENT_REQUIREMENT" "$legacy_seed"

write_legacy_fixture() {
  local home="$1" support="$1/Library/Application Support/Runtime Raiders"
  local legacy="$support/Runtime Raiders Agent.app" executable="$support/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent"
  local plist="$home/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist"
  local shim="$support/raiders" command="$home/.local/bin/raiders"
  mkdir -p "$support/state" "$support/outbox" "$support/rollback" "$support/failed-candidates" \
    "$support/diagnostics" "$support/update-workspace" "$home/Library/LaunchAgents" "$home/.local/bin"
  chmod 700 "$home" "$home/Library" "$home/Library/Application Support" "$support" "$support/state" \
    "$support/outbox" "$support/rollback" "$support/failed-candidates" "$support/diagnostics" \
    "$support/update-workspace" "$home/Library/LaunchAgents" "$home/.local" "$home/.local/bin"
  /usr/bin/ditto "$legacy_seed" "$legacy"
  write_enrollment "$home"
  printf '%s\n' rollback-evidence > "$support/rollback/sequence-8"
  printf '%s\n' failed-candidate-evidence > "$support/failed-candidates/sequence-7"
  printf '%s\n' diagnostics-evidence > "$support/diagnostics/sequence-3"
  printf '%s\n' update-workspace-evidence > "$support/update-workspace/sequence-8"
  chmod 600 "$support/rollback/sequence-8" "$support/failed-candidates/sequence-7" \
    "$support/diagnostics/sequence-3" "$support/update-workspace/sequence-8"
  /usr/bin/xattr -w com.redlattice.runtime-raiders-gate2 rollback "$support/rollback/sequence-8"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.redlattice.runtime-raiders-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$executable</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
  chmod 600 "$plist"
  cat > "$shim" <<EOF
#!/bin/sh
set -eu
SUPPORT='$support'
PLIST='$plist'
SHIM='$shim'
COMMAND_LINK_FILE='$support/state/command-link'
MARKER_FLAG='$support/state/path-marker-owned'
MARKER='export PATH="\$HOME/.local/bin:\$PATH" # runtime-raiders-path'
LABEL='com.redlattice.runtime-raiders-agent'
binary='$executable'
job_absent() {
  output="\$(mktemp /tmp/runtime-raiders-launchctl.XXXXXX)"
  if launchctl print "gui/\$(id -u)/\$LABEL" >"\$output" 2>&1; then
    rm -f "\$output"
    return 1
  else
    print_status=\$?
  fi
  [ "\$print_status" -eq 113 ] || { rm -f "\$output"; return 1; }
  grep -F 'Could not find service' "\$output" >/dev/null 2>&1
  status=\$?
  rm -f "\$output"
  return \$status
}
if [ "\$#" -eq 0 ] || [ "\$1" != uninstall ]; then
  exec "\$binary" "\$@"
fi
if "\$binary" uninstall; then
  launchctl bootout "gui/\$(id -u)" "\$PLIST" || {
    echo "Runtime Raiders bootout failed; refusing cleanup" >&2
    exit 1
  }
  job_absent || {
    echo "Runtime Raiders launchd job still present; refusing cleanup" >&2
    exit 1
  }
elif [ ! -S "\$SUPPORT/agent.sock" ] && job_absent; then
  :
else
  echo "Runtime Raiders daemon did not safely stop; refusing cleanup" >&2
  exit 1
fi
if [ -f "\$COMMAND_LINK_FILE" ]; then
  command_path="\$(cat "\$COMMAND_LINK_FILE")"
  if [ -L "\$command_path" ] && [ "\$(readlink "\$command_path")" = "\$SHIM" ]; then
    rm -f "\$command_path"
  fi
fi
profile="\$HOME/.zprofile"
if [ -f "\$MARKER_FLAG" ] && [ -f "\$profile" ]; then
  temporary="\$(mktemp "\$profile.runtime-raiders.XXXXXX")"
  awk -v marker="\$MARKER" 'seen == 0 && \$0 == marker { seen = 1; next } { print }' "\$profile" > "\$temporary"
  mv "\$temporary" "\$profile"
fi
rm -f "\$PLIST"
rm -rf "\$SUPPORT"
EOF
  chmod 700 "$shim"
  printf '%s\n' "$command" > "$support/state/command-link"
  chmod 600 "$support/state/command-link"
  ln -s "$shim" "$command"
}

fingerprint_legacy() {
  gate_fingerprint_migration_surface "$1" "$2"
}

injected_installer="$gate_root/install-with-failure-checkpoints.sh"
awk 'BEGIN { found=0 } $0 == "failure_checkpoint() { :; }" { print "failure_checkpoint() { [ \"${RUNTIME_RAIDERS_GATE2_FAIL_AFTER:-}\" != \"$1\" ] || return 91; }"; found=1; next } { print } END { if (!found) exit 1 }' "$INSTALLER" > "$injected_installer"
chmod 700 "$injected_installer"

for boundary in archive-verification enrollment-decision prepare old-job-stop launcher-directory releases-directory installation-directory launcher-placement release-placement state-write plist-replacement shim-replacement command-link-replacement bootstrap prepared-health resume; do
  echo "migration-failure-fingerprint $boundary"
  case_root="$gate_root/migration-$boundary"
  case_home="$case_root/home"
  mkdir -p "$case_home"
  write_legacy_fixture "$case_home"
  gate_env "$case_home" "$fake_bin/launchctl" bootstrap "gui/$OWNER" "$case_home/Library/LaunchAgents/com.redlattice.runtime-raiders-agent.plist"
  for _ in $(seq 1 80); do [ -S "$case_home/Library/Application Support/Runtime Raiders/agent.sock" ] && break; sleep 0.1; done
  [ -S "$case_home/Library/Application Support/Runtime Raiders/agent.sock" ] || exit 1
  fingerprint_legacy "$case_home" "$case_root/before.fingerprint"
  if gate_env "$case_home" env RUNTIME_RAIDERS_GATE2_FAIL_AFTER="$boundary" \
      /bin/sh "$injected_installer"; then
    echo "migration failure checkpoint unexpectedly succeeded: $boundary" >&2
    exit 1
  fi
  fingerprint_legacy "$case_home" "$case_root/after.fingerprint"
  cmp -s "$case_root/before.fingerprint" "$case_root/after.fingerprint" || {
    diff -u "$case_root/before.fingerprint" "$case_root/after.fingerprint" >&2 || true
    exit 1
  }
  gate_env "$case_home" "$fake_bin/launchctl" print "gui/$OWNER/com.redlattice.runtime-raiders-agent" >/dev/null
  legacy_executable="$case_home/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent"
  gate_run_without_release_credentials env HOME="$case_home" CFFIXED_USER_HOME="$case_home" \
    "$legacy_executable" __runtime-raiders-installer-status legacy-running false >/dev/null
  gate_env "$case_home" "$fake_bin/launchctl" bootout "gui/$OWNER/com.redlattice.runtime-raiders-agent"
done

echo "Runtime Raiders Gate 2 passed for local release $RELEASE_SEQUENCE-$RELEASE_SHA"
