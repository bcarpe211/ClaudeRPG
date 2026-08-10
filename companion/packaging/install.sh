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
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'
RELEASE_VALIDATOR_SHA256='__RUNTIME_RAIDERS_RELEASE_VALIDATOR_SHA256__'
RELEASE_VALIDATOR_BASE64='__RUNTIME_RAIDERS_RELEASE_VALIDATOR_BASE64__'
LABEL='com.redlattice.runtime-raiders-agent'
LEGACY_RELEASE_SHA='dec88d4f6ff600f2be92bed3b12dcfce85f84a51'
MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'

# The local lifecycle fixture replaces only this exact no-op definition. A
# published installer has no environment-controlled failure injection.
failure_checkpoint() { :; }

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
LEGACY_APP="$SUPPORT/Runtime Raiders Agent.app"
LEGACY_EXECUTABLE="$LEGACY_APP/Contents/MacOS/runtime-raiders-agent"
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
  "$SUPPORT" "$STATE" "$OUTBOX" "$LEGACY_APP" "$LAUNCHER_DIRECTORY" \
  "$LAUNCHER_APP" "$RELEASES_DIRECTORY" "$INSTALLATION_DIRECTORY" \
  "$PLIST" "$SHIM" "$COMMAND_LINK_FILE" "$MARKER_FLAG" "$COLLECTOR_STATE" "$ENROLLMENT"; do
  [ ! -L "$path" ] || { echo "Runtime Raiders refuses symlinked path: $path" >&2; exit 1; }
done

if [ -e "$RELEASE_STATE" ] || [ -e "$LAUNCHER_DIRECTORY" ] ||
   [ -e "$RELEASES_DIRECTORY" ] || [ -e "$INSTALLATION_DIRECTORY" ]; then
  echo "Runtime Raiders is already using versioned releases; run 'raiders update'." >&2
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
for path in "$PLIST" "$SHIM" "$COMMAND_LINK_FILE" "$MARKER_FLAG" "$COLLECTOR_STATE" "$ENROLLMENT"; do
  if [ -e "$path" ] && { [ ! -f "$path" ] || [ "$(stat -f %u "$path")" != "$(id -u)" ]; }; then
    echo "Runtime Raiders refuses unsafe file target: $path" >&2
    exit 1
  fi
done

migration=0
if [ -e "$LEGACY_APP" ]; then
  [ -d "$LEGACY_APP" ] && [ "$(stat -f %u "$LEGACY_APP")" = "$(id -u)" ] || {
    echo "Runtime Raiders refuses unsafe legacy application" >&2
    exit 1
  }
  LEGACY_INFO="$LEGACY_APP/Contents/Info.plist"
  [ -f "$LEGACY_INFO" ] && [ ! -L "$LEGACY_INFO" ] && [ -x "$LEGACY_EXECUTABLE" ] || {
    echo "Runtime Raiders can migrate only the complete sequence-8 installation" >&2
    exit 1
  }
  legacy_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$LEGACY_INFO")" &&
    legacy_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$LEGACY_INFO")" &&
    legacy_sequence="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSequence raw -o - "$LEGACY_INFO")" &&
    legacy_sha="$(/usr/bin/plutil -extract RuntimeRaidersReleaseSHA raw -o - "$LEGACY_INFO")" &&
    legacy_protocol="$(/usr/bin/plutil -extract RuntimeRaidersUpdateProtocolVersion raw -o - "$LEGACY_INFO")" || {
      echo "Runtime Raiders legacy release identity is invalid" >&2
      exit 1
    }
  [ "$legacy_bundle_id" = com.redlattice.runtime-raiders-agent ] &&
    [ "$legacy_version" = 0.2.6 ] && [ "$legacy_sequence" = 8 ] &&
    [ "$legacy_sha" = "$LEGACY_RELEASE_SHA" ] &&
    [ "$legacy_protocol" = 1 ] || {
      echo "Runtime Raiders can migrate only protocol-1 sequence 8" >&2
      exit 1
    }
  codesign --verify --strict -R="$AGENT_REQUIREMENT" "$LEGACY_APP"
  [ -f "$PLIST" ] && [ -f "$SHIM" ] && [ -f "$COMMAND_LINK_FILE" ] || {
    echo "Runtime Raiders can migrate only the complete sequence-8 installation" >&2
    exit 1
  }
  legacy_plist_label="$(/usr/bin/plutil -extract Label raw -o - "$PLIST")" &&
    legacy_plist_executable="$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$PLIST")" &&
    legacy_plist_mode="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$PLIST")" || {
      echo "Runtime Raiders can migrate only the complete sequence-8 installation" >&2
      exit 1
    }
  [ "$legacy_plist_label" = "$LABEL" ] &&
    [ "$legacy_plist_executable" = "$LEGACY_EXECUTABLE" ] &&
    [ "$legacy_plist_mode" = daemon ] && [ -x "$SHIM" ] &&
    grep -F "$LEGACY_EXECUTABLE" "$SHIM" >/dev/null 2>&1 || {
      echo "Runtime Raiders can migrate only the complete sequence-8 installation" >&2
      exit 1
    }
  legacy_command_path="$(cat "$COMMAND_LINK_FILE")"
  case "$legacy_command_path" in /*) ;; *) legacy_command_path='' ;; esac
  [ -n "$legacy_command_path" ] && [ -L "$legacy_command_path" ] &&
    [ "$(readlink "$legacy_command_path")" = "$SHIM" ] || {
      echo "Runtime Raiders can migrate only the complete sequence-8 installation" >&2
      exit 1
    }
  migration=1
elif [ -e "$PLIST" ] || [ -e "$SHIM" ] || [ -e "$COMMAND_LINK_FILE" ]; then
  echo "Runtime Raiders refuses an incomplete legacy installation" >&2
  exit 1
fi

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
if [ "$migration" -eq 1 ] && [ "$valid_enrollment" -ne 1 ]; then
  echo "Runtime Raiders sequence-8 migration requires its existing enrollment" >&2
  exit 1
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
        command_dir="$recorded_command_dir"
      fi
      ;;
  esac
fi
if [ -z "$command_path" ]; then
  old_ifs="$IFS"; IFS=:
  for candidate in $PATH; do
    case "$candidate" in /*) ;; *) continue ;; esac
    [ -n "$candidate" ] && [ -d "$candidate" ] && [ -w "$candidate" ] &&
      [ ! -L "$candidate" ] && [ "$(stat -f %u "$candidate")" = "$(id -u)" ] || continue
    command_dir="$candidate"
    break
  done
  IFS="$old_ifs"
fi
if [ -z "$command_dir" ]; then
  command_dir="$HOME/.local/bin"
  fallback_path=1
  [ ! -L "$HOME/.local" ] && [ ! -L "$command_dir" ] || {
    echo "Runtime Raiders refuses symlinked PATH destination" >&2
    exit 1
  }
fi
[ -n "$command_path" ] || command_path="$command_dir/raiders"
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ] || {
    echo "refusing to replace existing $command_path" >&2
    exit 1
  }
fi

WORK="$(mktemp -d "$SUPPORT/.install.XXXXXX")"
transaction_active=0
transaction_committed=0
lease_started=0
lease_pid=''
old_job_stopped=0
old_job_stop_attempted=0
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
prior_enabled=0
legacy_prepare_attempted=0
protected_state_mutated=0

close_lease() {
  [ "$lease_started" -eq 1 ] || return 0
  exec 9>&- || true
  wait "$lease_pid" >/dev/null 2>&1 || true
  lease_started=0
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

installer_agent_executable() {
  if [ -x "$CANDIDATE_AGENT_EXECUTABLE" ]; then printf '%s\n' "$CANDIDATE_AGENT_EXECUTABLE"
  elif [ -x "$RELEASE_EXECUTABLE" ]; then printf '%s\n' "$RELEASE_EXECUTABLE"
  else return 1
  fi
}

legacy_status_intent() {
  helper="$(installer_agent_executable)" || return 1
  "$helper" __runtime-raiders-installer-status legacy-running
}

wait_for_legacy_status() {
  expected_intent="$1"; expected_prepared="$2"
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    helper="$(installer_agent_executable)" || return 1
    if "$helper" __runtime-raiders-installer-status \
         "$expected_prepared" "$expected_intent"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  return 1
}

wait_for_candidate_status() {
  phase="$1"; expected_intent="$2"
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    if "$RELEASE_EXECUTABLE" __runtime-raiders-installer-status \
         "$phase" 1 "$expected_intent"; then
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

rollback_transaction() {
  [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ] || return 0
  transaction_active=0
  rollback_ok=1
  helper="$(installer_agent_executable)" || helper=''
  if [ "$migration" -eq 1 ] &&
     { [ -z "$helper" ] || ! assert_protected_state "$helper" "$WORK/protected-before"; }; then
    protected_state_mutated=1
  fi
  if [ "$new_job_bootstrap_attempted" -eq 1 ] ||
     [ "$old_job_stop_attempted" -eq 1 ] ||
     [ "$protected_state_mutated" -eq 1 ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    job_absent || rollback_ok=0
  fi
  if [ "$migration" -eq 1 ]; then
    [ "$plist_replaced" -eq 0 ] || restore_copy "$WORK/old.plist" "$PLIST" 600
    [ "$shim_replaced" -eq 0 ] || restore_copy "$WORK/old.shim" "$SHIM" 700
    if [ "$command_mutation_started" -eq 1 ]; then
      restore_copy "$WORK/old-command-link" "$COMMAND_LINK_FILE" 600
      rm -f "$command_path"
      /bin/ln -s "$SHIM" "$command_path" || rollback_ok=0
    fi
  else
    [ "$plist_replaced" -eq 0 ] || rm -f "$PLIST"
    [ "$shim_replaced" -eq 0 ] || rm -f "$SHIM"
    if [ "$command_mutation_started" -eq 1 ]; then
      rm -f "$COMMAND_LINK_FILE"
      [ ! -L "$command_path" ] || rm -f "$command_path"
    fi
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
  if [ "$migration" -eq 1 ]; then
    helper="$(installer_agent_executable)" || helper=''
    if [ -z "$helper" ] || ! assert_protected_state "$helper" "$WORK/protected-before"; then
      protected_state_mutated=1
    fi
    if [ "$protected_state_mutated" -eq 1 ]; then
      launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
      job_absent || rollback_ok=0
    elif [ "$old_job_stop_attempted" -eq 1 ] || [ "$new_job_bootstrap_attempted" -eq 1 ]; then
      launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || rollback_ok=0
    fi
    helper="$(installer_agent_executable)" || helper=''
    if [ "$protected_state_mutated" -eq 0 ] &&
       { [ -z "$helper" ] || ! assert_protected_state "$helper" "$WORK/protected-before"; }; then
      protected_state_mutated=1
      launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
      job_absent || rollback_ok=0
    fi
    if [ "$legacy_prepare_attempted" -eq 1 ] && [ "$protected_state_mutated" -eq 0 ]; then
      wait_for_legacy_status "$prior_intent" legacy-prepared >/dev/null 2>&1 || rollback_ok=0
      if [ -n "${helper:-}" ]; then
        "$helper" __runtime-raiders-legacy-resume >/dev/null 2>&1 || rollback_ok=0
      fi
    fi
    if [ "$protected_state_mutated" -eq 0 ]; then
      wait_for_legacy_status "$prior_intent" legacy-running >/dev/null 2>&1 || rollback_ok=0
      helper="$(installer_agent_executable)" || helper=''
      if [ -z "$helper" ] || ! assert_protected_state "$helper" "$WORK/protected-before"; then
        protected_state_mutated=1
        launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
        job_absent || rollback_ok=0
      fi
    fi
    [ "$protected_state_mutated" -eq 0 ] || rollback_ok=0
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

if [ "$migration" -eq 1 ]; then
  "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-validate-legacy || {
    echo "Runtime Raiders can migrate only the exact sequence-8 installation" >&2
    exit 1
  }
fi

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

if [ "$migration" -eq 1 ]; then
  prior_intent="$(legacy_status_intent)" || {
      echo "Runtime Raiders cannot safely prepare the sequence-8 daemon" >&2
      exit 1
    }
  case "$prior_intent" in enabled|disabled) ;; *) echo "Runtime Raiders cannot preserve collection intent" >&2; exit 1 ;; esac
else
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
fi

capture_protected_state "$CANDIDATE_AGENT_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders could not fingerprint protected local state" >&2
  exit 1
}

if [ "$migration" -eq 1 ]; then
  cp -p "$PLIST" "$WORK/old.plist"
  cp -p "$SHIM" "$WORK/old.shim"
  cp -p "$COMMAND_LINK_FILE" "$WORK/old-command-link"
fi
transaction_active=1

mkfifo "$WORK/lease.fifo"
"$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-lease <"$WORK/lease.fifo" >"$WORK/lease.ready" &
lease_pid=$!
printf '%s\n' "$lease_pid" > "$WORK/lease.pid"
chmod 600 "$WORK/lease.pid"
exec 9>"$WORK/lease.fifo"
lease_started=1
attempt=0
while [ "$attempt" -lt 40 ] && ! grep -F -x 'runtime-raiders-installer-lease-ready' "$WORK/lease.ready" >/dev/null 2>&1; do
  attempt=$((attempt + 1)); sleep 0.05
done
grep -F -x 'runtime-raiders-installer-lease-ready' "$WORK/lease.ready" >/dev/null 2>&1 || {
  echo "Runtime Raiders installer lease did not become ready" >&2
  exit 1
}

if [ "$migration" -eq 1 ]; then
  legacy_prepare_attempted=1
  "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-legacy-prepare >/dev/null
  wait_for_legacy_status "$prior_intent" legacy-prepared || {
      echo "Runtime Raiders legacy daemon did not prepare" >&2
      exit 1
    }
  assert_protected_state "$CANDIDATE_AGENT_EXECUTABLE" "$WORK/protected-before" || {
    echo "Runtime Raiders protected local state changed during preparation" >&2
    exit 1
  }
  failure_checkpoint prepare
  old_job_stop_attempted=1
  launchctl bootout "gui/$(id -u)/$LABEL"
  old_job_stopped=1
  job_absent || { echo "Runtime Raiders could not prove the old job stopped" >&2; exit 1; }
  failure_checkpoint old-job-stop
else
  job_absent || { echo "Runtime Raiders refuses an unexpected launchd job" >&2; exit 1; }
fi

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

staged_release_state="$(mktemp "$INSTALLATION_DIRECTORY/.release-state.XXXXXX")"
printf '{"schema_version":1,"generation":1,"active":{"release_sequence":%s,"release_sha":"%s","companion_version":"%s","update_protocol_version":2},"fallback":null,"trial":null}\n' \
  "$RELEASE_SEQUENCE" "$RELEASE_SHA" "$VERSION" > "$staged_release_state"
chmod 600 "$staged_release_state"
mv "$staged_release_state" "$RELEASE_STATE"; state_written=1
failure_checkpoint state-write

staged_plist="$(mktemp "$WORK/plist.XXXXXX")"
cat > "$staged_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$LAUNCHER_EXECUTABLE</string><string>daemon</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
</dict></plist>
EOF
chmod 600 "$staged_plist"
mv "$staged_plist" "$PLIST"; plist_replaced=1
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
wait_for_candidate_status candidate-prepared "$prior_intent" || {
  echo "Runtime Raiders candidate did not reach prepared health" >&2
  exit 1
}
assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders protected local state changed at prepared health" >&2
  exit 1
}
failure_checkpoint prepared-health
"$RELEASE_EXECUTABLE" __runtime-raiders-installer-resume 1 >/dev/null
wait_for_candidate_status candidate-resumed "$prior_intent" || {
  echo "Runtime Raiders candidate did not restore collection intent" >&2
  exit 1
}
assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders protected local state changed after resume" >&2
  exit 1
}
failure_checkpoint resume
close_lease
transaction_committed=1
echo "Runtime Raiders installed. Run 'raiders status' to check it."
