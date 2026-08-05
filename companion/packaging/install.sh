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
LABEL='com.redlattice.runtime-raiders-agent'
MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'

usage() {
  echo "usage: install.sh [--code-file <owner-only-file>]" >&2
  exit 64
}
code_file=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --code-file) [ "$#" -ge 2 ] && [ -z "$code_file" ] || usage; code_file="$2"; shift 2 ;;
    *) usage ;;
  esac
done
if [ -n "$code_file" ]; then
  [ -f "$code_file" ] && [ ! -L "$code_file" ] || {
    echo "Runtime Raiders refuses unsafe one-time code file" >&2
    exit 1
  }
  [ "$(stat -f %u "$code_file")" = "$(id -u)" ] &&
    [ "$(stat -f %Lp "$code_file")" = 600 ] || {
      echo "Runtime Raiders refuses unsafe one-time code file" >&2
      exit 1
    }
  code_file_bytes="$(wc -c < "$code_file" | tr -d ' ')"
  case "$code_file_bytes" in 43|44) ;; *) usage ;; esac
  code="$(cat "$code_file")"
else
  [ -r /dev/tty ] && [ -w /dev/tty ] || usage
  tty_state="$(stty -g < /dev/tty)" || usage
  restore_tty() {
    stty "$tty_state" < /dev/tty 2>/dev/null || true
  }
  trap 'restore_tty; exit 1' HUP INT TERM
  printf 'Runtime Raiders one-time code: ' > /dev/tty
  stty -echo < /dev/tty
  if ! IFS= read -r code < /dev/tty; then
    restore_tty
    usage
  fi
  restore_tty
  printf '\n' > /dev/tty
  trap - HUP INT TERM
fi
case "$code" in *[!A-Za-z0-9_-]*|'') usage ;; esac
code_length="$(printf '%s' "$code" | wc -c | tr -d ' ')"
[ "$code_length" -eq 43 ] || usage
[ "$ARTIFACT_URL" = "$RUNTIME_RAIDERS_ORIGIN/downloads/runtime-raiders-agent.zip" ] &&
  [ "$CHECKSUM_URL" = "$RUNTIME_RAIDERS_ORIGIN/downloads/runtime-raiders-agent.zip.sha256" ] &&
  [ "$ENROLL_URL" = "$RUNTIME_RAIDERS_ORIGIN/api/raiders/enroll" ] || {
    echo "Runtime Raiders installer origin is invalid" >&2
    exit 1
  }
case "$TEAM_ID" in *[!A-Z0-9]*|'') echo "Runtime Raiders installer has no rendered signing Team ID" >&2; exit 1 ;; esac
[ "$(printf '%s' "$TEAM_ID" | wc -c | tr -d ' ')" -eq 10 ] || { echo "Runtime Raiders installer has an invalid signing Team ID" >&2; exit 1; }
REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

umask 077
SUPPORT="$HOME/Library/Application Support/Runtime Raiders"
STATE="$SUPPORT/state"
OUTBOX="$SUPPORT/outbox"
APP="$SUPPORT/Runtime Raiders Agent.app"
EXECUTABLE="$APP/Contents/MacOS/runtime-raiders-agent"
SHIM="$SUPPORT/raiders"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
COMMAND_LINK_FILE="$STATE/command-link"
MARKER_FLAG="$STATE/path-marker-owned"
COLLECTOR_STATE="$STATE/collector-state.json"
for path in "$HOME/Library" "$HOME/Library/Application Support" "$HOME/Library/LaunchAgents" "$SUPPORT" "$STATE" "$OUTBOX" "$APP" "$PLIST" "$SHIM" "$COMMAND_LINK_FILE" "$MARKER_FLAG" "$COLLECTOR_STATE"; do
  [ ! -L "$path" ] || { echo "Runtime Raiders refuses symlinked path: $path" >&2; exit 1; }
done
if [ -e "$APP" ] && { [ ! -d "$APP" ] || [ "$(stat -f %u "$APP")" != "$(id -u)" ]; }; then
  echo "Runtime Raiders refuses unsafe app target" >&2
  exit 1
fi
for path in "$SUPPORT" "$STATE" "$OUTBOX"; do
  if [ -e "$path" ] && { [ ! -d "$path" ] || [ "$(stat -f %u "$path")" != "$(id -u)" ]; }; then
    echo "Runtime Raiders refuses unsafe directory: $path" >&2
    exit 1
  fi
done
if [ -e "$HOME/Library/LaunchAgents" ] && { [ ! -d "$HOME/Library/LaunchAgents" ] || [ "$(stat -f %u "$HOME/Library/LaunchAgents")" != "$(id -u)" ]; }; then
  echo "Runtime Raiders refuses unsafe LaunchAgents directory" >&2
  exit 1
fi
for path in "$PLIST" "$SHIM" "$COMMAND_LINK_FILE" "$MARKER_FLAG" "$COLLECTOR_STATE"; do
  if [ -e "$path" ] && { [ ! -f "$path" ] || [ "$(stat -f %u "$path")" != "$(id -u)" ]; }; then
    echo "Runtime Raiders refuses unsafe file target: $path" >&2
    exit 1
  fi
done
mkdir -p "$STATE" "$OUTBOX" "$HOME/Library/LaunchAgents"
chmod 700 "$SUPPORT" "$STATE" "$OUTBOX"
command_dir=''
command_path=''
fallback_path=0
if [ -f "$COMMAND_LINK_FILE" ]; then
  recorded_command_path="$(cat "$COMMAND_LINK_FILE")"
  case "$recorded_command_path" in
    /*)
      recorded_command_dir="$(dirname "$recorded_command_path")"
      if [ -d "$recorded_command_dir" ] && [ ! -L "$recorded_command_dir" ] &&
         [ "$(stat -f %u "$recorded_command_dir")" = "$(id -u)" ] &&
         [ -L "$recorded_command_path" ] && [ "$(readlink "$recorded_command_path")" = "$SHIM" ]; then
        command_path="$recorded_command_path"
        command_dir="$(dirname "$command_path")"
      fi
      ;;
  esac
fi

status_from() {
  status_output="$("$1" status)" || return 1
}

status_reports_live() {
  status_from "$1" || return 1
  case "$status_output" in
    *'"daemonRunning":true'*) return 0 ;;
    *) return 1 ;;
  esac
}

status_is_offline_disabled() {
  status_from "$1" || return 1
  case "$status_output" in
    *'"daemonRunning":false'*'"enabled":false'*'"persistedState":"disabled"'*) return 0 ;;
    *) return 1 ;;
  esac
}

status_is_live_disabled() {
  status_from "$1" || return 1
  case "$status_output" in
    *'"daemonRunning":true'*'"enabled":false'*'"persistedState":"disabled"'*) return 0 ;;
    *) return 1 ;;
  esac
}

persist_fresh_off_state() {
  temporary_state="$(mktemp "$STATE/.collector-state.XXXXXX")"
  printf '{"enabled":false,"files":{},"version":1}\n' > "$temporary_state"
  chmod 600 "$temporary_state"
  mv "$temporary_state" "$COLLECTOR_STATE"
}

launch_job_absent() {
  launch_output="$(mktemp "$WORK/launchctl-print.XXXXXX")"
  if launchctl print "gui/$(id -u)/$LABEL" >"$launch_output" 2>&1; then
    rm -f "$launch_output"
    return 1
  else
    launch_status=$?
  fi
  [ "$launch_status" -eq 113 ] || { rm -f "$launch_output"; return 1; }
  grep -F 'Could not find service' "$launch_output" >/dev/null 2>&1
  absent_status=$?
  rm -f "$launch_output"
  return "$absent_status"
}

wait_for_daemon_stopped() {
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    if status_from "$1"; then
      case "$status_output" in
        *'"daemonRunning":false'*) return 0 ;;
      esac
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  return 1
}

wait_for_live_disabled() {
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    status_is_live_disabled "$1" && return 0
    attempt=$((attempt + 1))
    sleep 0.25
  done
  return 1
}
if [ -z "$command_path" ]; then
  old_ifs="$IFS"
  IFS=:
  for candidate in $PATH; do
    case "$candidate" in /*) ;; *) continue ;; esac
    [ -n "$candidate" ] && [ -d "$candidate" ] && [ -w "$candidate" ] || continue
    [ ! -L "$candidate" ] || continue
    [ "$(stat -f %u "$candidate")" = "$(id -u)" ] || continue
    command_dir="$candidate"
    break
  done
  IFS="$old_ifs"
fi
if [ -z "$command_dir" ]; then
  command_dir="$HOME/.local/bin"
  fallback_path=1
  [ ! -L "$HOME/.local" ] && [ ! -L "$command_dir" ] || { echo "Runtime Raiders refuses symlinked PATH destination" >&2; exit 1; }
fi
[ -n "$command_path" ] || command_path="$command_dir/raiders"
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ] || {
    echo "refusing to replace existing $command_path" >&2
    exit 1
  }
fi
if [ "$fallback_path" -eq 1 ] && { [ -L "$HOME/.zprofile" ] || { [ -e "$HOME/.zprofile" ] && [ ! -f "$HOME/.zprofile" ]; }; }; then
  echo "Runtime Raiders refuses unsafe shell profile" >&2
  exit 1
fi
if [ "$fallback_path" -eq 1 ] && [ -e "$HOME/.zprofile" ] && [ "$(stat -f %u "$HOME/.zprofile")" != "$(id -u)" ]; then
  echo "Runtime Raiders refuses unowned shell profile" >&2
  exit 1
fi
WORK="$(mktemp -d "$SUPPORT/.install.XXXXXX")"
transaction_active=0
transaction_committed=0
had_app=0
had_plist=0
had_shim=0
had_command_record=0
had_command_link=0
had_profile=0
had_marker_flag=0
profile_touched=0
old_command_target=''
new_app=0
new_plist=0
new_shim=0
rollback_transaction() {
  [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ] || return 0
  transaction_active=0
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  [ "$new_app" -eq 0 ] || rm -rf "$APP"
  [ "$new_plist" -eq 0 ] || rm -f "$PLIST"
  [ "$new_shim" -eq 0 ] || rm -f "$SHIM"
  [ "$had_app" -eq 0 ] || mv "$WORK/old.app" "$APP"
  [ "$had_plist" -eq 0 ] || mv "$WORK/old.plist" "$PLIST"
  [ "$had_shim" -eq 0 ] || mv "$WORK/old.shim" "$SHIM"
  if [ "$had_command_record" -eq 1 ]; then
    rm -f "$COMMAND_LINK_FILE"
    mv "$WORK/old-command-link" "$COMMAND_LINK_FILE"
  else
    rm -f "$COMMAND_LINK_FILE"
  fi
  if [ "$had_command_link" -eq 1 ]; then
    if [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ]; then rm -f "$command_path"; fi
    [ -e "$command_path" ] || [ -L "$command_path" ] || /bin/ln -s "$old_command_target" "$command_path"
  elif [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ]; then
    rm -f "$command_path"
  fi
  if [ "$profile_touched" -eq 1 ]; then
    if [ "$had_profile" -eq 1 ]; then
      rm -f "$profile"
      mv "$WORK/old-profile" "$profile"
    else
      rm -f "$profile"
    fi
  fi
  if [ "$had_marker_flag" -eq 1 ]; then
    rm -f "$MARKER_FLAG"
    mv "$WORK/old-marker-flag" "$MARKER_FLAG"
  else
    rm -f "$MARKER_FLAG"
  fi
  [ "$had_plist" -eq 0 ] || launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
}
cleanup() {
  status=$?
  rollback_transaction
  rm -rf "$WORK"
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

ARCHIVE="$WORK/runtime-raiders-agent.zip"
CHECKSUM="$WORK/runtime-raiders-agent.zip.sha256"
artifact_status="$(curl --silent --show-error \
  --proto '=https' --proto-redir '=https' --max-redirs 0 \
  --connect-timeout 10 --max-time 120 --max-filesize 134217728 \
  -o "$ARCHIVE" -w '%{http_code}' "$ARTIFACT_URL")"
[ "$artifact_status" = 200 ] || {
  echo "Runtime Raiders artifact download was not accepted" >&2
  exit 1
}
checksum_status="$(curl --silent --show-error \
  --proto '=https' --proto-redir '=https' --max-redirs 0 \
  --connect-timeout 10 --max-time 30 --max-filesize 4096 \
  -o "$CHECKSUM" -w '%{http_code}' "$CHECKSUM_URL")"
[ "$checksum_status" = 200 ] || {
  echo "Runtime Raiders checksum download was not accepted" >&2
  exit 1
}
expected="$(awk 'NR == 1 { print $1 }' "$CHECKSUM")"
actual="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
expected_length="$(printf '%s' "$expected" | wc -c | tr -d ' ')"
case "$expected" in *[!0123456789abcdef]*|'') echo "invalid Runtime Raiders checksum" >&2; exit 1 ;; esac
[ "$expected_length" -eq 64 ] && [ "$actual" = "$expected" ] || {
  echo "Runtime Raiders download checksum verification failed" >&2
  exit 1
}
ditto -x -k "$ARCHIVE" "$WORK/unpacked"
CANDIDATE="$WORK/unpacked/Runtime Raiders Agent.app"
[ -f "$CANDIDATE/Contents/MacOS/runtime-raiders-agent" ] || {
  echo "Runtime Raiders archive is missing its app executable" >&2
  exit 1
}
INFO_PLIST="$CANDIDATE/Contents/Info.plist"
[ -f "$INFO_PLIST" ] && [ ! -L "$INFO_PLIST" ] || {
  echo "Runtime Raiders candidate release identity is invalid" >&2
  exit 1
}
candidate_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$INFO_PLIST")" &&
  candidate_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST")" &&
  candidate_sequence="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$INFO_PLIST")" &&
  candidate_sha="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$INFO_PLIST")" &&
  candidate_protocol="$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$INFO_PLIST")" || {
  echo "Runtime Raiders candidate release identity is invalid" >&2
  exit 1
}
[ "$candidate_bundle_id" = 'com.redlattice.runtime-raiders-agent' ] &&
  [ "$candidate_version" = "$VERSION" ] &&
  [ "$candidate_sequence" = "$RELEASE_SEQUENCE" ] &&
  [ "$candidate_sha" = "$RELEASE_SHA" ] &&
  [ "$candidate_protocol" = "$UPDATE_PROTOCOL_VERSION" ] || {
  echo "Runtime Raiders candidate release identity is invalid" >&2
  exit 1
}
codesign --verify --strict -R="$REQUIREMENT" "$CANDIDATE"

ENROLLMENT="$STATE/enrollment.json"
[ ! -L "$ENROLLMENT" ] || { echo "Runtime Raiders refuses symlinked enrollment" >&2; exit 1; }
if [ -e "$ENROLLMENT" ] && { [ ! -f "$ENROLLMENT" ] || [ "$(stat -f %u "$ENROLLMENT")" != "$(id -u)" ]; }; then
  echo "Runtime Raiders refuses unsafe enrollment" >&2
  exit 1
fi
new_enrollment=0
if [ ! -f "$ENROLLMENT" ]; then
  new_enrollment=1
  device_id="$(uuidgen)"
  response="$WORK/enrollment-response.json"
  request="$WORK/enrollment-request.json"
  printf '{"code":"%s","device_id":"%s","companion_version":"%s"}' \
    "$code" "$device_id" "$VERSION" > "$request"
  chmod 600 "$request"
  if ! enrollment_status="$(curl --silent --show-error \
      --proto '=https' --proto-redir '=https' --max-redirs 0 \
      --connect-timeout 10 --max-time 30 --max-filesize 65536 \
      -X POST -H 'Content-Type: application/json' --data-binary @- \
      -w '%{http_code}' -o "$response" "$ENROLL_URL" < "$request")"; then
    rm -f "$request"
    echo "Runtime Raiders enrollment was not accepted" >&2
    exit 1
  fi
  rm -f "$request"
  [ "$enrollment_status" = 201 ] || {
    echo "Runtime Raiders enrollment was not accepted" >&2
    exit 1
  }
  device_token="$(plutil -extract device_token raw -o - "$response")"
  dedupe_secret="$(plutil -extract dedupe_secret raw -o - "$response")"
  server_url="$(plutil -extract server_url raw -o - "$response")"
  cutover_at="$(plutil -extract cutover_at raw -o - "$response")"
  enabled_surfaces="$(plutil -extract enabled_surfaces json -o - "$response")"
  case "$device_token" in *[!A-Za-z0-9_-]*|'') exit 1 ;; esac
  case "$dedupe_secret" in *[!0123456789abcdef]*|'') exit 1 ;; esac
  case "$cutover_at" in *[!0123456789]*|'') exit 1 ;; esac
  token_length="$(printf '%s' "$device_token" | wc -c | tr -d ' ')"
  secret_length="$(printf '%s' "$dedupe_secret" | wc -c | tr -d ' ')"
  [ "$token_length" -eq 43 ] && [ "$secret_length" -eq 64 ] || {
    echo "invalid Runtime Raiders enrollment response" >&2
    exit 1
  }
  [ "$server_url" = 'https://raiders.redlattice.com' ] || {
    echo "invalid Runtime Raiders enrollment server" >&2
    exit 1
  }
  [ "$enabled_surfaces" = '["codex_desktop","codex_cli"]' ] || {
    echo "invalid Runtime Raiders enrollment surfaces" >&2
    exit 1
  }
  STAGED_ENROLLMENT="$(mktemp "$WORK/enrollment.XXXXXX")"
  printf '{"version":1,"device_id":"%s","device_token":"%s","dedupe_secret":"%s","server_url":"%s","cutover_at":%s,"enabled_surfaces":%s}\n' \
    "$device_id" "$device_token" "$dedupe_secret" "$server_url" "$cutover_at" "$enabled_surfaces" > "$STAGED_ENROLLMENT"
  chmod 600 "$STAGED_ENROLLMENT"
fi

# The installer owns the activation boundary. Quiesce any live prior daemon and
# remove its launchd job before trusting persisted state. Missing or invalid
# state is then replaced atomically with the reviewed disabled v1 state.
CANDIDATE_EXECUTABLE="$CANDIDATE/Contents/MacOS/runtime-raiders-agent"
CONTROL_EXECUTABLE="$CANDIDATE_EXECUTABLE"
if [ -d "$APP" ]; then
  codesign --verify --strict -R="$REQUIREMENT" "$APP"
  CONTROL_EXECUTABLE="$EXECUTABLE"
fi
if status_reports_live "$CONTROL_EXECUTABLE"; then
  "$CONTROL_EXECUTABLE" off >/dev/null 2>&1 || true
fi
if ! launch_job_absent; then
  launchctl bootout "gui/$(id -u)/$LABEL" || {
    echo "Runtime Raiders could not stop the existing launchd job" >&2
    exit 1
  }
fi
launch_job_absent || {
  echo "Runtime Raiders could not verify the existing launchd job is absent" >&2
  exit 1
}
wait_for_daemon_stopped "$CANDIDATE_EXECUTABLE" || {
  echo "Runtime Raiders could not verify the existing daemon is stopped" >&2
  exit 1
}
if ! status_is_offline_disabled "$CANDIDATE_EXECUTABLE"; then
  persist_fresh_off_state
fi
status_is_offline_disabled "$CANDIDATE_EXECUTABLE" || {
  echo "Runtime Raiders could not validate persisted disabled state" >&2
  exit 1
}

transaction_active=1
if [ -e "$APP" ]; then
  mv "$APP" "$WORK/old.app"
  had_app=1
fi
if [ -e "$PLIST" ]; then
  mv "$PLIST" "$WORK/old.plist"
  had_plist=1
fi
if [ -e "$SHIM" ]; then
  mv "$SHIM" "$WORK/old.shim"
  had_shim=1
fi
if [ -f "$COMMAND_LINK_FILE" ]; then
  cp -p "$COMMAND_LINK_FILE" "$WORK/old-command-link"
  had_command_record=1
fi
if [ -L "$command_path" ]; then
  old_command_target="$(readlink "$command_path")"
  had_command_link=1
fi
if [ "$fallback_path" -eq 1 ]; then
  profile="$HOME/.zprofile"
  if [ -f "$profile" ]; then
    cp -p "$profile" "$WORK/old-profile"
    had_profile=1
  fi
  if [ -f "$MARKER_FLAG" ]; then
    cp -p "$MARKER_FLAG" "$WORK/old-marker-flag"
    had_marker_flag=1
  fi
fi
mv "$CANDIDATE" "$APP"
new_app=1
chmod 700 "$EXECUTABLE"
if [ ! -f "$ENROLLMENT" ]; then
  mv "$STAGED_ENROLLMENT" "$ENROLLMENT"
  chmod 600 "$ENROLLMENT"
fi
STAGED_PLIST="$(mktemp "$WORK/plist.XXXXXX")"
cat > "$STAGED_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.redlattice.runtime-raiders-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXECUTABLE</string>
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
chmod 600 "$STAGED_PLIST"

if [ "$fallback_path" -eq 1 ]; then
  profile="$HOME/.zprofile"
  profile_touched=1
  mkdir -p "$command_dir"
  [ -e "$HOME/.local" ] || chmod 700 "$HOME/.local"
  [ -e "$command_dir" ] || chmod 700 "$command_dir"
  [ -e "$profile" ] || { : > "$profile"; chmod 600 "$profile"; }
  grep -F -x "$MARKER" "$profile" >/dev/null 2>&1 || {
    temporary="$(mktemp "$profile.runtime-raiders.XXXXXX")"
    cat "$profile" > "$temporary"
    printf '%s\n' "$MARKER" >> "$temporary"
    mv "$temporary" "$profile"
    : > "$MARKER_FLAG"
    chmod 600 "$MARKER_FLAG"
    echo "Added Runtime Raiders to PATH in $profile; open a new shell to use raiders."
  }
fi
STAGED_SHIM="$(mktemp "$WORK/shim.XXXXXX")"
cat > "$STAGED_SHIM" <<EOF
#!/bin/sh
set -eu
SUPPORT='$SUPPORT'
PLIST='$PLIST'
SHIM='$SHIM'
COMMAND_LINK_FILE='$COMMAND_LINK_FILE'
MARKER_FLAG='$MARKER_FLAG'
MARKER='$MARKER'
LABEL='$LABEL'
binary='$EXECUTABLE'
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
chmod 700 "$STAGED_SHIM"
mv "$STAGED_PLIST" "$PLIST"
new_plist=1
mv "$STAGED_SHIM" "$SHIM"
new_shim=1
printf '%s\n' "$command_path" > "$COMMAND_LINK_FILE"
chmod 600 "$COMMAND_LINK_FILE"
ln -sfn "$SHIM" "$command_path"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "Runtime Raiders launchd bootstrap failed; prior installation restored" >&2
  exit 1
fi
wait_for_live_disabled "$EXECUTABLE" || {
  echo "Runtime Raiders launchd did not produce a live verified-off daemon" >&2
  exit 1
}
transaction_committed=1
echo "Runtime Raiders installed. Run 'raiders status' to check it."
