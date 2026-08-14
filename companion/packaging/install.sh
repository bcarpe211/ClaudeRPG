#!/bin/sh
set -eu

ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'
ENROLL_URL='https://raiders.redlattice.com/api/raiders/enroll'
RUNTIME_RAIDERS_ORIGIN='https://raiders.redlattice.com'
VERSION='__RUNTIME_RAIDERS_COMPANION_VERSION__'
RELEASE_SEQUENCE='__RUNTIME_RAIDERS_RELEASE_SEQUENCE__'
RELEASE_SHA='__RUNTIME_RAIDERS_RELEASE_SHA__'
UPDATE_PROTOCOL_VERSION='__RUNTIME_RAIDERS_UPDATE_PROTOCOL_VERSION__'
MAX_PROTECTED_SNAPSHOT_BYTES=134217728
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'
RELEASE_VALIDATOR_SHA256='__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__'
RELEASE_VALIDATOR_BASE64='__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__'
LABEL='com.redlattice.runtime-raiders-agent'
MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'

# The local lifecycle fixture replaces only this exact no-op definition. A
# published installer has no environment-controlled failure injection.
failure_checkpoint() { :; }
durable_checkpoint() { :; }

usage() {
  echo "usage: install.sh [--code-file <owner-only-file>]" >&2
  exit 64
}

code_file=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --code-file)
      [ "$#" -ge 2 ] && [ -z "$code_file" ] || usage
      code_file="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[ "$ARTIFACT_URL" = "$RUNTIME_RAIDERS_ORIGIN/downloads/runtime-raiders-agent.zip" ] &&
  [ "$CHECKSUM_URL" = "$RUNTIME_RAIDERS_ORIGIN/downloads/runtime-raiders-agent.zip.sha256" ] &&
  [ "$ENROLL_URL" = "$RUNTIME_RAIDERS_ORIGIN/api/raiders/enroll" ] || {
    echo "Runtime Raiders installer origin is invalid" >&2
    exit 1
  }
case "$TEAM_ID" in *[!A-Z0-9]*|'') echo "Runtime Raiders installer has no rendered signing Team ID" >&2; exit 1 ;; esac
[ "$(printf '%s' "$TEAM_ID" | wc -c | tr -d ' ')" -eq 10 ] || {
  echo "Runtime Raiders installer has an invalid signing Team ID" >&2
  exit 1
}
case "$RELEASE_SEQUENCE" in *[!0-9]*|'') exit 1 ;; esac
case "$RELEASE_SHA" in *[!0123456789abcdef]*|'') exit 1 ;; esac
[ "${#RELEASE_SHA}" -eq 40 ] && [ "$UPDATE_PROTOCOL_VERSION" = 2 ] || {
  echo "Runtime Raiders installer requires update protocol 2" >&2
  exit 1
}

AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'
LAUNCHER_REQUIREMENT='identifier "com.redlattice.runtime-raiders-launcher" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

umask 077
SUPPORT="$HOME/Library/Application Support/Runtime Raiders"
STATE="$SUPPORT/state"
OUTBOX="$SUPPORT/outbox"
LAUNCHER_DIRECTORY="$SUPPORT/launcher"
LAUNCHER_APP="$LAUNCHER_DIRECTORY/Runtime Raiders Launcher.app"
LAUNCHER_EXECUTABLE="$LAUNCHER_APP/Contents/MacOS/runtime-raiders-launcher"
RELEASES_DIRECTORY="$SUPPORT/releases"
RELEASE_DIRECTORY="$RELEASES_DIRECTORY/sequence-$RELEASE_SEQUENCE-$RELEASE_SHA"
RELEASE_APP="$RELEASE_DIRECTORY/Runtime Raiders Agent.app"
RELEASE_EXECUTABLE="$RELEASE_APP/Contents/MacOS/runtime-raiders-agent"
INSTALLATION_DIRECTORY="$SUPPORT/installation"
RELEASE_STATE="$INSTALLATION_DIRECTORY/release-state.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SHIM="$SUPPORT/raiders"
COMMAND_LINK_FILE="$STATE/command-link"
MARKER_FLAG="$STATE/path-marker-owned"
COLLECTOR_STATE="$STATE/collector-state.json"
ENROLLMENT="$STATE/enrollment.json"

for path in \
  "$HOME/Library" "$HOME/Library/Application Support" "$HOME/Library/LaunchAgents" \
  "$SUPPORT" "$STATE" "$OUTBOX" "$LAUNCHER_DIRECTORY" "$LAUNCHER_APP" \
  "$RELEASES_DIRECTORY" "$INSTALLATION_DIRECTORY" "$PLIST" "$SHIM" \
  "$COMMAND_LINK_FILE" "$MARKER_FLAG" "$COLLECTOR_STATE" "$ENROLLMENT"; do
  [ ! -L "$path" ] || { echo "Runtime Raiders refuses symlinked path: $path" >&2; exit 1; }
done

if [ -e "$RELEASE_STATE" ] || [ -e "$LAUNCHER_DIRECTORY" ] ||
   [ -e "$RELEASES_DIRECTORY" ] || [ -e "$INSTALLATION_DIRECTORY" ]; then
  echo "Runtime Raiders is already installed; run raiders update." >&2
  exit 1
fi
if [ -e "$SUPPORT/Runtime Raiders Agent.app" ] || [ -e "$PLIST" ] ||
   [ -e "$SHIM" ] || [ -e "$COMMAND_LINK_FILE" ]; then
  echo "Runtime Raiders found a legacy installation; use the reviewed one-time canary migrator." >&2
  exit 1
fi

for path in "$SUPPORT" "$STATE" "$OUTBOX"; do
  if [ -e "$path" ] && { [ ! -d "$path" ] || [ "$(stat -f %u "$path")" != "$(id -u)" ]; }; then
    echo "Runtime Raiders refuses unsafe directory: $path" >&2
    exit 1
  fi
done
if [ -e "$HOME/Library/LaunchAgents" ] && {
  [ ! -d "$HOME/Library/LaunchAgents" ] ||
  [ "$(stat -f %u "$HOME/Library/LaunchAgents")" != "$(id -u)" ];
}; then
  echo "Runtime Raiders refuses unsafe LaunchAgents directory" >&2
  exit 1
fi
for path in "$MARKER_FLAG" "$COLLECTOR_STATE" "$ENROLLMENT"; do
  if [ -e "$path" ] && { [ ! -f "$path" ] || [ "$(stat -f %u "$path")" != "$(id -u)" ]; }; then
    echo "Runtime Raiders refuses unsafe file target: $path" >&2
    exit 1
  fi
done

mkdir -p "$STATE" "$OUTBOX" "$HOME/Library/LaunchAgents"
chmod 700 "$SUPPORT" "$STATE" "$OUTBOX"

valid_enrollment=0
validate_enrollment() {
  [ -f "$ENROLLMENT" ] && [ ! -L "$ENROLLMENT" ] &&
    [ "$(stat -f %u "$ENROLLMENT")" = "$(id -u)" ] &&
    [ "$(stat -f %Lp "$ENROLLMENT")" = 600 ] || return 1
  enrollment_version="$(/usr/bin/plutil -extract version raw -o - "$ENROLLMENT")" &&
    enrollment_device_id="$(/usr/bin/plutil -extract device_id raw -o - "$ENROLLMENT")" &&
    enrollment_token="$(/usr/bin/plutil -extract device_token raw -o - "$ENROLLMENT")" &&
    enrollment_secret="$(/usr/bin/plutil -extract dedupe_secret raw -o - "$ENROLLMENT")" &&
    enrollment_server="$(/usr/bin/plutil -extract server_url raw -o - "$ENROLLMENT")" &&
    enrollment_cutover="$(/usr/bin/plutil -extract cutover_at raw -o - "$ENROLLMENT")" &&
    enrollment_surfaces="$(/usr/bin/plutil -extract enabled_surfaces json -o - "$ENROLLMENT")" || return 1
  [ "$enrollment_version" = 1 ] &&
    [ "$enrollment_server" = "$RUNTIME_RAIDERS_ORIGIN" ] &&
    [ "$enrollment_surfaces" = '["codex_desktop","codex_cli"]' ] || return 1
  case "$enrollment_device_id" in *[!A-Fa-f0-9-]*|'') return 1 ;; esac
  case "$enrollment_token" in *[!A-Za-z0-9_-]*|'') return 1 ;; esac
  case "$enrollment_secret" in *[!0123456789abcdef]*|'') return 1 ;; esac
  case "$enrollment_cutover" in *[!0123456789]*|'') return 1 ;; esac
  [ "${#enrollment_token}" -eq 43 ] && [ "${#enrollment_secret}" -eq 64 ]
}
if [ -e "$ENROLLMENT" ]; then
  validate_enrollment || { echo "Runtime Raiders refuses invalid existing enrollment" >&2; exit 1; }
  valid_enrollment=1
fi
code=''
if [ "$valid_enrollment" -eq 0 ]; then
  if [ -n "$code_file" ]; then
    [ -f "$code_file" ] && [ ! -L "$code_file" ] &&
      [ "$(stat -f %u "$code_file")" = "$(id -u)" ] &&
      [ "$(stat -f %Lp "$code_file")" = 600 ] || {
        echo "Runtime Raiders refuses unsafe one-time code file" >&2
        exit 1
      }
    case "$(wc -c < "$code_file" | tr -d ' ')" in 43|44) ;; *) usage ;; esac
    code="$(cat "$code_file")"
  else
    [ -r /dev/tty ] && [ -w /dev/tty ] || usage
    tty_state="$(stty -g < /dev/tty)" || usage
    restore_tty() { stty "$tty_state" < /dev/tty 2>/dev/null || true; }
    trap 'restore_tty; exit 1' HUP INT TERM
    printf 'Runtime Raiders one-time code: ' > /dev/tty
    stty -echo < /dev/tty
    IFS= read -r code < /dev/tty || { restore_tty; usage; }
    restore_tty
    printf '\n' > /dev/tty
    trap - HUP INT TERM
  fi
  case "$code" in *[!A-Za-z0-9_-]*|'') usage ;; esac
  [ "${#code}" -eq 43 ] || usage
fi

command_dir=''
command_path=''
fallback_path=1
command_dir="$HOME/.local/bin"
command_path="$command_dir/raiders"
[ ! -L "$HOME/.local" ] && [ ! -L "$command_dir" ] || {
  echo "Runtime Raiders refuses symlinked PATH destination" >&2
  exit 1
}
[ ! -e "$command_path" ] && [ ! -L "$command_path" ] || {
  echo "refusing to replace existing $command_path" >&2
  exit 1
}

WORK="$(mktemp -d "$SUPPORT/.install.XXXXXX")"
transaction_active=0
transaction_committed=0
lease_started=0
lease_pid=''
new_job_bootstrapped=0
new_job_bootstrap_attempted=0
launcher_created=0
releases_created=0
installation_created=0
launcher_placed=0
release_placed=0
state_written=0
plist_replaced=0
shim_replaced=0
command_replaced=0
command_mutation_started=0
profile_touched=0
had_profile=0
had_marker=0
prior_queued_event_count=0

close_lease() {
  [ "$lease_started" -eq 1 ] || return 0
  exec 9>&- || true
  wait "$lease_pid" >/dev/null 2>&1 || true
  lease_started=0
}

start_lease() {
  lease_executable="$1"
  [ "$lease_started" -eq 0 ] || return 0
  rm -f "$WORK/lease.fifo" "$WORK/lease.ready" "$WORK/lease.pid"
  mkfifo "$WORK/lease.fifo"
  "$lease_executable" __runtime-raiders-installer-lease <"$WORK/lease.fifo" >"$WORK/lease.ready" &
  lease_pid=$!
  printf '%s\n' "$lease_pid" > "$WORK/lease.pid"
  chmod 600 "$WORK/lease.pid"
  exec 9>"$WORK/lease.fifo"
  lease_started=1
  attempt=0
  while [ "$attempt" -lt 40 ] && [ ! -s "$WORK/lease.ready" ]; do
    kill -0 "$lease_pid" >/dev/null 2>&1 || return 1
    attempt=$((attempt + 1))
    sleep 0.05
  done
  [ -s "$WORK/lease.ready" ] &&
    [ "$(cat "$WORK/lease.ready")" = runtime-raiders-installer-lease-ready ]
}

job_absent() {
  output="$(mktemp "$WORK/launchctl.XXXXXX")"
  if launchctl print "gui/$(id -u)/$LABEL" >"$output" 2>&1; then
    rm -f "$output"
    return 1
  else
    result=$?
  fi
  [ "$result" -eq 113 ] && grep -F 'Could not find service' "$output" >/dev/null 2>&1
  result=$?
  rm -f "$output"
  return "$result"
}

wait_for_candidate_status() {
  phase="$1"; expected_intent="$2"; expected_queue="$3"
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    if "$RELEASE_EXECUTABLE" __runtime-raiders-installer-status \
         "$phase" 1 "$expected_intent" "$expected_queue"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  return 1
}

capture_protected_state() {
  executable="$1"; destination="$2"
  temporary="$(mktemp "$WORK/protected-state.XXXXXX")"
  "$executable" __runtime-raiders-installer-protected-state > "$temporary" || {
    rm -f "$temporary"
    return 1
  }
  private_regular_file "$temporary" 600 "$MAX_PROTECTED_SNAPSHOT_BYTES" || {
    rm -f "$temporary"
    return 1
  }
  mv "$temporary" "$destination"
}

assert_protected_state() {
  executable="$1"; expected="$2"
  capture_protected_state "$executable" "$WORK/protected-current" || return 1
  cmp -s "$expected" "$WORK/protected-current"
}

safe_remove_created() {
  path="$1"
  [ -e "$path" ] || return 0
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(stat -f %u "$path")" = "$(id -u)" ] || return 1
  rm -rf "$path"
}

restore_copy() {
  source="$1"; destination="$2"; mode="$3"
  temporary="$(mktemp "$destination.restore.XXXXXX")"
  cp -p "$source" "$temporary"
  chmod "$mode" "$temporary"
  mv "$temporary" "$destination"
}

private_regular_file() {
  file="$1"; expected_mode="$2"; maximum_size="$3"
  [ -f "$file" ] && [ ! -L "$file" ] &&
    [ "$(stat -f %u "$file")" = "$(id -u)" ] &&
    [ "$(stat -f %Lp "$file")" = "$expected_mode" ] &&
    [ "$(stat -f %l "$file")" = 1 ] &&
    [ "$(stat -f %z "$file")" -le "$maximum_size" ]
}

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
}

valid_sha256() {
  value="$1"
  case "$value" in *[!0123456789abcdef]*|'') return 1 ;; esac
  [ "${#value}" -eq 64 ]
}

write_committed_release_state() {
  temporary="$(mktemp "$INSTALLATION_DIRECTORY/.release-state.XXXXXX")"
  printf '{"schema_version":1,"generation":1,"active":{"release_sequence":%s,"release_sha":"%s","companion_version":"%s","update_protocol_version":2},"fallback":null,"trial":null}\n' \
    "$RELEASE_SEQUENCE" "$RELEASE_SHA" "$VERSION" > "$temporary"
  chmod 600 "$temporary"
  if [ -e "$RELEASE_STATE" ] || [ -L "$RELEASE_STATE" ]; then
    private_regular_file "$RELEASE_STATE" 600 16384 && cmp -s "$temporary" "$RELEASE_STATE" || {
      rm -f "$temporary"
      return 1
    }
    rm -f "$temporary"
  else
    mv "$temporary" "$RELEASE_STATE" || return 1
  fi
  "$RELEASE_EXECUTABLE" __runtime-raiders-installer-sync-migration active-release-state || return 1
  state_written=1
}

install_launchd_plist() {
  launch_mode="$1"
  staged_plist="$(mktemp "$WORK/plist.XXXXXX")"
  case "$launch_mode" in
    stable)
      launch_arguments="<string>$LAUNCHER_EXECUTABLE</string><string>daemon</string>"
      ;;
    *) rm -f "$staged_plist"; return 1 ;;
  esac
  cat > "$staged_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array>$launch_arguments</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
</dict></plist>
EOF
  chmod 600 "$staged_plist"
  mv "$staged_plist" "$PLIST" || return 1
  plist_replaced=1
  /bin/sync
}

rollback_transaction() {
  [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ] || return 0
  transaction_active=0
  rollback_ok=1
  if [ "$new_job_bootstrap_attempted" -eq 1 ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    job_absent || rollback_ok=0
  fi
  [ "$plist_replaced" -eq 0 ] || rm -f "$PLIST"
  [ "$shim_replaced" -eq 0 ] || rm -f "$SHIM"
  if [ "$command_mutation_started" -eq 1 ]; then
    rm -f "$COMMAND_LINK_FILE"
    [ ! -L "$command_path" ] || rm -f "$command_path"
  fi
  [ "$state_written" -eq 0 ] || rm -f "$RELEASE_STATE"
  if [ "$profile_touched" -eq 1 ]; then
    if [ "$had_profile" -eq 1 ]; then restore_copy "$WORK/old.profile" "$HOME/.zprofile" 600
    else rm -f "$HOME/.zprofile"
    fi
    if [ "$had_marker" -eq 1 ]; then restore_copy "$WORK/old-marker" "$MARKER_FLAG" 600
    else rm -f "$MARKER_FLAG"
    fi
  fi
  [ "$release_placed" -eq 0 ] || safe_remove_created "$RELEASE_DIRECTORY" || rollback_ok=0
  [ "$launcher_placed" -eq 0 ] || safe_remove_created "$LAUNCHER_APP" || rollback_ok=0
  [ "$installation_created" -eq 0 ] || safe_remove_created "$INSTALLATION_DIRECTORY" || rollback_ok=0
  [ "$releases_created" -eq 0 ] || safe_remove_created "$RELEASES_DIRECTORY" || rollback_ok=0
  [ "$launcher_created" -eq 0 ] || safe_remove_created "$LAUNCHER_DIRECTORY" || rollback_ok=0
  close_lease
  [ "$rollback_ok" -eq 1 ]
}

cleanup() {
  status=$?
  rollback_transaction || status=1
  close_lease
  rm -rf "$WORK"
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

RELEASE_VALIDATOR="$WORK/runtime-raiders-release-validator"
case "$RELEASE_VALIDATOR_SHA256" in *[!0123456789abcdef]*|'') exit 1 ;; esac
[ "${#RELEASE_VALIDATOR_SHA256}" -eq 64 ] || exit 1
printf '%s' "$RELEASE_VALIDATOR_BASE64" | /usr/bin/base64 -D > "$RELEASE_VALIDATOR"
chmod 700 "$RELEASE_VALIDATOR"
validator_actual="$(/usr/bin/shasum -a 256 "$RELEASE_VALIDATOR" | awk 'NR == 1 { print $1 }')"
[ "$validator_actual" = "$RELEASE_VALIDATOR_SHA256" ] || {
  echo "Runtime Raiders embedded validator verification failed" >&2
  exit 1
}
RELEASE_VALIDATOR_BASE64=''

ARCHIVE="$WORK/runtime-raiders-agent.zip"
CHECKSUM="$WORK/runtime-raiders-agent.zip.sha256"
artifact_status="$(curl --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 0 \
  --connect-timeout 10 --max-time 120 --max-filesize 134217728 -o "$ARCHIVE" -w '%{http_code}' "$ARTIFACT_URL")"
[ "$artifact_status" = 200 ] || { echo "Runtime Raiders artifact download was not accepted" >&2; exit 1; }
checksum_status="$(curl --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 0 \
  --connect-timeout 10 --max-time 30 --max-filesize 4096 -o "$CHECKSUM" -w '%{http_code}' "$CHECKSUM_URL")"
[ "$checksum_status" = 200 ] || { echo "Runtime Raiders checksum download was not accepted" >&2; exit 1; }
expected="$(awk 'NR == 1 { print $1 }' "$CHECKSUM")"
actual="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1}')"
case "$expected" in *[!0123456789abcdef]*|'') exit 1 ;; esac
[ "${#expected}" -eq 64 ] && [ "$actual" = "$expected" ] || {
  echo "Runtime Raiders download checksum verification failed" >&2
  exit 1
}
"$RELEASE_VALIDATOR" "$ARCHIVE" || {
  echo "Runtime Raiders archive structure validation failed" >&2
  exit 1
}
mkdir "$WORK/unpacked"
ditto -x -k "$ARCHIVE" "$WORK/unpacked"
CONTAINER="$WORK/unpacked/Runtime Raiders Release"
CANDIDATE_AGENT="$CONTAINER/Runtime Raiders Agent.app"
CANDIDATE_AGENT_EXECUTABLE="$CANDIDATE_AGENT/Contents/MacOS/runtime-raiders-agent"
CANDIDATE_LAUNCHER="$CONTAINER/Runtime Raiders Launcher.app"
CANDIDATE_LAUNCHER_EXECUTABLE="$CANDIDATE_LAUNCHER/Contents/MacOS/runtime-raiders-launcher"
[ "$(find "$WORK/unpacked" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 1 ] &&
  [ "$(find "$CONTAINER" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 2 ] &&
[ -x "$CANDIDATE_AGENT_EXECUTABLE" ] && [ -x "$CANDIDATE_LAUNCHER_EXECUTABLE" ] || {
    echo "Runtime Raiders archive does not contain the exact two-application release" >&2
    exit 1
  }
"$RELEASE_VALIDATOR" "$ARCHIVE" "$WORK/unpacked" \
  "$RELEASE_SEQUENCE" "$RELEASE_SHA" "$VERSION" "$UPDATE_PROTOCOL_VERSION" "$TEAM_ID" || {
  echo "Runtime Raiders extracted release trust validation failed" >&2
  exit 1
}
AGENT_INFO="$CANDIDATE_AGENT/Contents/Info.plist"
LAUNCHER_INFO="$CANDIDATE_LAUNCHER/Contents/Info.plist"
candidate_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$AGENT_INFO")" &&
  candidate_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$AGENT_INFO")" &&
  candidate_sequence="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$AGENT_INFO")" &&
  candidate_sha="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$AGENT_INFO")" &&
  candidate_protocol="$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$AGENT_INFO")" &&
  launcher_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$LAUNCHER_INFO")" &&
  launcher_protocol="$(/usr/bin/plutil -extract RuntimeRaidersLauncherProtocolVersion raw -o - "$LAUNCHER_INFO")" || {
    echo "Runtime Raiders candidate release identity is invalid" >&2
    exit 1
  }
[ "$candidate_bundle_id" = com.redlattice.runtime-raiders-agent ] &&
  [ "$candidate_version" = "$VERSION" ] && [ "$candidate_sequence" = "$RELEASE_SEQUENCE" ] &&
  [ "$candidate_sha" = "$RELEASE_SHA" ] && [ "$candidate_protocol" = 2 ] &&
  [ "$launcher_bundle_id" = com.redlattice.runtime-raiders-launcher ] && [ "$launcher_protocol" = 1 ] || {
    echo "Runtime Raiders candidate release identity is invalid" >&2
    exit 1
  }
codesign --verify --strict -R="$AGENT_REQUIREMENT" "$CANDIDATE_AGENT"
codesign --verify --strict -R="$LAUNCHER_REQUIREMENT" "$CANDIDATE_LAUNCHER"
self_check="$("$CANDIDATE_AGENT_EXECUTABLE" __self-check)" || exit 1
printf '%s' "$self_check" | grep -F "\"release_sequence\":$RELEASE_SEQUENCE" >/dev/null 2>&1 || exit 1
printf '%s' "$self_check" | grep -F "\"release_sha\":\"$RELEASE_SHA\"" >/dev/null 2>&1 || exit 1
printf '%s' "$self_check" | grep -F '"update_protocol_version":2' >/dev/null 2>&1 || exit 1
failure_checkpoint archive-verification

if [ "$valid_enrollment" -eq 0 ]; then
  response="$WORK/enrollment-response.json"
  request="$WORK/enrollment-request.json"
  device_id="$(uuidgen)"
  printf '{"code":"%s","device_id":"%s","companion_version":"%s"}' "$code" "$device_id" "$VERSION" > "$request"
  chmod 600 "$request"
  enrollment_status="$(curl --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 0 \
    --connect-timeout 10 --max-time 30 --max-filesize 65536 -X POST -H 'Content-Type: application/json' \
    --data-binary @- -w '%{http_code}' -o "$response" "$ENROLL_URL" < "$request")"
  rm -f "$request"
  [ "$enrollment_status" = 201 ] || { echo "Runtime Raiders enrollment was not accepted" >&2; exit 1; }
  device_token="$(/usr/bin/plutil -extract device_token raw -o - "$response")"
  dedupe_secret="$(/usr/bin/plutil -extract dedupe_secret raw -o - "$response")"
  server_url="$(/usr/bin/plutil -extract server_url raw -o - "$response")"
  cutover_at="$(/usr/bin/plutil -extract cutover_at raw -o - "$response")"
  enabled_surfaces="$(/usr/bin/plutil -extract enabled_surfaces json -o - "$response")"
  [ "$server_url" = "$RUNTIME_RAIDERS_ORIGIN" ] && [ "$enabled_surfaces" = '["codex_desktop","codex_cli"]' ] &&
    [ "${#device_token}" -eq 43 ] && [ "${#dedupe_secret}" -eq 64 ] || exit 1
  staged_enrollment="$(mktemp "$STATE/.enrollment.XXXXXX")"
  printf '{"version":1,"device_id":"%s","device_token":"%s","dedupe_secret":"%s","server_url":"%s","cutover_at":%s,"enabled_surfaces":%s}\n' \
    "$device_id" "$device_token" "$dedupe_secret" "$server_url" "$cutover_at" "$enabled_surfaces" > "$staged_enrollment"
  chmod 600 "$staged_enrollment"
  mv "$staged_enrollment" "$ENROLLMENT"
  valid_enrollment=1
fi
failure_checkpoint enrollment-decision

prior_intent=disabled
if [ ! -e "$COLLECTOR_STATE" ]; then
  staged_state="$(mktemp "$STATE/.collector-state.XXXXXX")"
  printf '{"enabled":false,"files":{},"version":1}\n' > "$staged_state"
  chmod 600 "$staged_state"
  mv "$staged_state" "$COLLECTOR_STATE"
else
  grep -F '"enabled":false' "$COLLECTOR_STATE" >/dev/null 2>&1 || {
    echo "Runtime Raiders refuses unsafe fresh collector state" >&2
    exit 1
  }
fi

capture_protected_state "$CANDIDATE_AGENT_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders could not fingerprint protected local state" >&2
  exit 1
}

transaction_active=1

start_lease "$CANDIDATE_AGENT_EXECUTABLE" || {
  echo "Runtime Raiders installer lease did not become ready" >&2
  exit 1
}

job_absent || { echo "Runtime Raiders refuses an unexpected launchd job" >&2; exit 1; }

mkdir "$LAUNCHER_DIRECTORY"; chmod 700 "$LAUNCHER_DIRECTORY"; launcher_created=1
failure_checkpoint launcher-directory
mkdir "$RELEASES_DIRECTORY"; chmod 700 "$RELEASES_DIRECTORY"; releases_created=1
failure_checkpoint releases-directory
mkdir "$INSTALLATION_DIRECTORY"; chmod 700 "$INSTALLATION_DIRECTORY"; installation_created=1
failure_checkpoint installation-directory

mv "$CANDIDATE_LAUNCHER" "$LAUNCHER_APP"; launcher_placed=1
failure_checkpoint launcher-placement
mkdir "$RELEASE_DIRECTORY"; chmod 700 "$RELEASE_DIRECTORY"
mv "$CANDIDATE_AGENT" "$RELEASE_APP"; release_placed=1
failure_checkpoint release-placement

write_committed_release_state
durable_checkpoint state-write
failure_checkpoint state-write
install_launchd_plist stable
failure_checkpoint plist-replacement

staged_shim="$(mktemp "$WORK/shim.XXXXXX")"
cat > "$staged_shim" <<EOF
#!/bin/sh
set -eu
SUPPORT='$SUPPORT'
PLIST='$PLIST'
SHIM='$SHIM'
COMMAND_LINK_FILE='$COMMAND_LINK_FILE'
MARKER_FLAG='$MARKER_FLAG'
MARKER='$MARKER'
LABEL='$LABEL'
launcher='$LAUNCHER_EXECUTABLE'
job_absent() {
  output="\$(mktemp /tmp/runtime-raiders-launchctl.XXXXXX)"
  if launchctl print "gui/\$(id -u)/\$LABEL" >"\$output" 2>&1; then rm -f "\$output"; return 1; else result=\$?; fi
  [ "\$result" -eq 113 ] && grep -F 'Could not find service' "\$output" >/dev/null 2>&1
  result=\$?; rm -f "\$output"; return "\$result"
}
if [ "\$#" -eq 0 ] || [ "\$1" != uninstall ]; then exec "\$launcher" "\$@"; fi
if "\$launcher" uninstall; then
  launchctl bootout "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || true
  job_absent || { echo 'Runtime Raiders launchd job still present; refusing cleanup' >&2; exit 1; }
else
  echo 'Runtime Raiders daemon did not safely stop; refusing cleanup' >&2; exit 1
fi
if [ -f "\$COMMAND_LINK_FILE" ]; then
  command_path="\$(cat "\$COMMAND_LINK_FILE")"
  if [ -L "\$command_path" ] && [ "\$(readlink "\$command_path")" = "\$SHIM" ]; then rm -f "\$command_path"; fi
fi
profile="\$HOME/.zprofile"
if [ -f "\$MARKER_FLAG" ] && [ -f "\$profile" ]; then
  temporary="\$(mktemp "\$profile.runtime-raiders.XXXXXX")"
  awk -v marker="\$MARKER" 'seen == 0 && \$0 == marker { seen = 1; next } { print }' "\$profile" > "\$temporary"
  mv "\$temporary" "\$profile"
fi
rm -f "\$PLIST"; rm -rf "\$SUPPORT"
EOF
chmod 700 "$staged_shim"
mv "$staged_shim" "$SHIM"; shim_replaced=1
failure_checkpoint shim-replacement

if [ "$fallback_path" -eq 1 ]; then
  profile="$HOME/.zprofile"
  mkdir -p "$command_dir"
  [ -e "$HOME/.local" ] || chmod 700 "$HOME/.local"
  chmod 700 "$command_dir"
  if [ -f "$profile" ]; then cp -p "$profile" "$WORK/old.profile"; had_profile=1
  else : > "$profile"; chmod 600 "$profile"
  fi
  if [ -f "$MARKER_FLAG" ]; then cp -p "$MARKER_FLAG" "$WORK/old-marker"; had_marker=1; fi
  profile_touched=1
  grep -F -x "$MARKER" "$profile" >/dev/null 2>&1 || {
    temporary="$(mktemp "$profile.runtime-raiders.XXXXXX")"
    cat "$profile" > "$temporary"; printf '%s\n' "$MARKER" >> "$temporary"; mv "$temporary" "$profile"
    : > "$MARKER_FLAG"; chmod 600 "$MARKER_FLAG"
  }
fi
staged_command_record="$(mktemp "$STATE/.command-link.XXXXXX")"
printf '%s\n' "$command_path" > "$staged_command_record"; chmod 600 "$staged_command_record"
command_mutation_started=1
mv "$staged_command_record" "$COMMAND_LINK_FILE"
rm -f "$command_path"
/bin/ln -s "$SHIM" "$command_path"
command_replaced=1
failure_checkpoint command-link-replacement

new_job_bootstrap_attempted=1
launchctl bootstrap "gui/$(id -u)" "$PLIST"; new_job_bootstrapped=1
failure_checkpoint bootstrap
wait_for_candidate_status candidate-prepared "$prior_intent" "$prior_queued_event_count" || {
  echo "Runtime Raiders candidate did not reach prepared health" >&2
  exit 1
}
assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders protected local state changed at prepared health" >&2
  exit 1
}
failure_checkpoint prepared-health
"$RELEASE_EXECUTABLE" __runtime-raiders-installer-resume 1 >/dev/null
wait_for_candidate_status candidate-resumed "$prior_intent" "$prior_queued_event_count" || {
  echo "Runtime Raiders candidate did not restore collection intent" >&2
  exit 1
}
assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders protected local state changed after resume" >&2
  exit 1
}
close_lease
transaction_committed=1
echo "Runtime Raiders installed. Run 'raiders status' to check it."
