#!/bin/sh
set -eu

ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'
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
LEGACY_RELEASE_SHA='dec88d4f6ff600f2be92bed3b12dcfce85f84a51'
LEGACY_COMMAND_PATH='/opt/homebrew/opt/libpq/bin/raiders'
MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'

# The local lifecycle fixture replaces only this exact no-op definition. A
# published installer has no environment-controlled failure injection.
failure_checkpoint() { :; }
durable_checkpoint() { :; }

usage() {
  echo "usage: migrate.sh" >&2
  exit 64
}

[ "$#" -eq 0 ] || usage

[ "$ARTIFACT_URL" = "$RUNTIME_RAIDERS_ORIGIN/downloads/runtime-raiders-agent.zip" ] &&
  [ "$CHECKSUM_URL" = "$RUNTIME_RAIDERS_ORIGIN/downloads/runtime-raiders-agent.zip.sha256" ] || {
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
MIGRATION_DIRECTORY="$SUPPORT/.migration-v1"
MIGRATION_STAGING_DIRECTORY="$SUPPORT/.migration-v1.staging"
MIGRATION_STAGING_TOMBSTONE="$SUPPORT/.migration-v1.staging-tombstone"
MIGRATION_TOMBSTONE_DIRECTORY="$SUPPORT/.migration-v1.tombstone"
MIGRATION_ROLLBACK_TOMBSTONE="$SUPPORT/.migration-v1.rollback-tombstone"
MIGRATION_JOURNAL="$MIGRATION_DIRECTORY/journal.json"
MIGRATION_HELPER_APP="$MIGRATION_DIRECTORY/Runtime Raiders Agent.app"
MIGRATION_HELPER_EXECUTABLE="$MIGRATION_HELPER_APP/Contents/MacOS/runtime-raiders-agent"
MIGRATION_STAGING_HELPER_APP="$MIGRATION_STAGING_DIRECTORY/Runtime Raiders Agent.app"
MIGRATION_STAGING_HELPER_EXECUTABLE="$MIGRATION_STAGING_HELPER_APP/Contents/MacOS/runtime-raiders-agent"

for path in \
  "$HOME/Library" "$HOME/Library/Application Support" "$HOME/Library/LaunchAgents" \
  "$SUPPORT" "$STATE" "$OUTBOX" "$LEGACY_APP" "$LAUNCHER_DIRECTORY" \
  "$LAUNCHER_APP" "$RELEASES_DIRECTORY" "$INSTALLATION_DIRECTORY" \
  "$PLIST" "$SHIM" "$COMMAND_LINK_FILE" "$MARKER_FLAG" "$COLLECTOR_STATE" "$ENROLLMENT"; do
  [ ! -L "$path" ] || { echo "Runtime Raiders refuses symlinked path: $path" >&2; exit 1; }
done

recovery_pending=0
staging_pending=0
cleanup_tombstone_pending=0
cleanup_tombstone_context=''
cleanup_tombstone_path=''
if { [ -e "$MIGRATION_TOMBSTONE_DIRECTORY" ] || [ -L "$MIGRATION_TOMBSTONE_DIRECTORY" ]; } &&
   { [ -e "$MIGRATION_ROLLBACK_TOMBSTONE" ] || [ -L "$MIGRATION_ROLLBACK_TOMBSTONE" ]; }; then
  echo "Runtime Raiders refuses conflicting migration cleanup tombstones" >&2
  exit 1
fi
if { [ -e "$MIGRATION_DIRECTORY" ] || [ -L "$MIGRATION_DIRECTORY" ]; } &&
   { [ -e "$MIGRATION_TOMBSTONE_DIRECTORY" ] || [ -L "$MIGRATION_TOMBSTONE_DIRECTORY" ] ||
     [ -e "$MIGRATION_ROLLBACK_TOMBSTONE" ] || [ -L "$MIGRATION_ROLLBACK_TOMBSTONE" ]; }; then
  echo "Runtime Raiders refuses conflicting migration journals" >&2
  exit 1
fi
for tombstone_context in accepted rollback; do
  case "$tombstone_context" in
    accepted) tombstone_path="$MIGRATION_TOMBSTONE_DIRECTORY" ;;
    rollback) tombstone_path="$MIGRATION_ROLLBACK_TOMBSTONE" ;;
  esac
  if [ -e "$tombstone_path" ] || [ -L "$tombstone_path" ]; then
    [ -d "$tombstone_path" ] && [ ! -L "$tombstone_path" ] &&
      [ "$(stat -f %u "$tombstone_path")" = "$(id -u)" ] &&
      [ "$(stat -f %Lp "$tombstone_path")" = 700 ] || {
      echo "Runtime Raiders refuses an unsafe migration tombstone" >&2
      exit 1
    }
    cleanup_tombstone_pending=1
    cleanup_tombstone_context="$tombstone_context"
    cleanup_tombstone_path="$tombstone_path"
  fi
done
if [ -e "$MIGRATION_DIRECTORY" ] || [ -L "$MIGRATION_DIRECTORY" ]; then
  [ -d "$MIGRATION_DIRECTORY" ] && [ ! -L "$MIGRATION_DIRECTORY" ] &&
    [ "$(stat -f %u "$MIGRATION_DIRECTORY")" = "$(id -u)" ] &&
    [ "$(stat -f %Lp "$MIGRATION_DIRECTORY")" = 700 ] || {
      echo "Runtime Raiders refuses an unsafe migration journal" >&2
      exit 1
    }
  recovery_pending=1
fi
for staging_path in "$MIGRATION_STAGING_DIRECTORY" "$MIGRATION_STAGING_TOMBSTONE"; do
  if [ -e "$staging_path" ] || [ -L "$staging_path" ]; then
    [ -d "$staging_path" ] && [ ! -L "$staging_path" ] &&
      [ "$(stat -f %u "$staging_path")" = "$(id -u)" ] &&
      [ "$(stat -f %Lp "$staging_path")" = 700 ] || {
        echo "Runtime Raiders refuses unsafe migration staging" >&2
        exit 1
      }
    staging_pending=1
  fi
done

if [ "$recovery_pending" -eq 0 ] && [ "$cleanup_tombstone_pending" -eq 0 ] &&
   { [ -e "$RELEASE_STATE" ] || [ -e "$LAUNCHER_DIRECTORY" ] ||
   [ -e "$RELEASES_DIRECTORY" ] || [ -e "$INSTALLATION_DIRECTORY" ]; }; then
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
if [ "$cleanup_tombstone_pending" -eq 1 ] &&
   [ "$cleanup_tombstone_context" = accepted ]; then
  # An accepted journal has already committed the versioned installation. Its
  # fixed-name tombstone is deletion-only recovery state, so do not try to
  # classify the now-versioned files as a legacy installation before retiring
  # the remaining tombstone contents.
  migration=0
elif [ "$recovery_pending" -eq 1 ]; then
  [ -d "$LEGACY_APP" ] && [ ! -L "$LEGACY_APP" ] || {
    echo "Runtime Raiders cannot recover without its flat sequence-8 application" >&2
    exit 1
  }
  migration=1
elif [ -e "$LEGACY_APP" ]; then
  [ -d "$LEGACY_APP" ] && [ "$(stat -f %u "$LEGACY_APP")" = "$(id -u)" ] &&
    [ "$(stat -f %Lp "$LEGACY_APP")" = 700 ] || {
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
  [ "$legacy_command_path" = "$LEGACY_COMMAND_PATH" ] &&
    [ "$(wc -l < "$COMMAND_LINK_FILE" | tr -d ' ')" = 1 ] || {
      echo "Runtime Raiders can migrate only the complete sequence-8 installation" >&2
      exit 1
    }
  migration=1
elif [ -e "$PLIST" ] || [ -e "$SHIM" ] || [ -e "$COMMAND_LINK_FILE" ]; then
  echo "Runtime Raiders refuses an incomplete legacy installation" >&2
  exit 1
fi
if [ "$migration" -eq 0 ] && ! {
  [ "$cleanup_tombstone_pending" -eq 1 ] && [ "$cleanup_tombstone_context" = accepted ];
}; then
  echo "This one-time migrator accepts only the exact sequence-8 canary." >&2
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

command_dir=''
command_path=''
command_dir="$HOME/.local/bin"
command_path="$command_dir/raiders"
[ ! -L "$HOME/.local" ] && [ ! -L "$command_dir" ] || {
  echo "Runtime Raiders refuses symlinked PATH destination" >&2
  exit 1
}
if [ "$recovery_pending" -eq 0 ] && ! {
  [ "$cleanup_tombstone_pending" -eq 1 ] && [ "$cleanup_tombstone_context" = accepted ];
}; then
  [ ! -e "$command_path" ] && [ ! -L "$command_path" ] || {
    echo "Runtime Raiders refuses an unexpected canonical command" >&2
    exit 1
  }
elif [ -e "$command_path" ] || [ -L "$command_path" ]; then
  [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ] || {
    echo "refusing to recover through existing $command_path" >&2
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

installer_agent_executable() {
  if [ -n "${CANDIDATE_AGENT_EXECUTABLE:-}" ] && [ -x "$CANDIDATE_AGENT_EXECUTABLE" ]; then printf '%s\n' "$CANDIDATE_AGENT_EXECUTABLE"
  elif [ -x "$RELEASE_EXECUTABLE" ]; then printf '%s\n' "$RELEASE_EXECUTABLE"
  elif [ -x "$MIGRATION_HELPER_EXECUTABLE" ]; then printf '%s\n' "$MIGRATION_HELPER_EXECUTABLE"
  else return 1
  fi
}

legacy_status_snapshot() {
  helper="$(installer_agent_executable)" || return 1
  "$helper" __runtime-raiders-installer-status legacy-running
}

wait_for_legacy_status() {
  expected_intent="$1"; expected_prepared="$2"; expected_queue="$3"
  attempt=0
  while [ "$attempt" -lt 40 ]; do
    helper="$(installer_agent_executable)" || return 1
    if "$helper" __runtime-raiders-installer-status \
         "$expected_prepared" "$expected_intent" "$expected_queue"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  return 1
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

emit_migration_journal() {
  printf '{"schema_version":1,"phase":"%s","prior_intent":"%s","queued_event_count":%s,"release_sequence":%s,"release_sha":"%s","companion_version":"%s","plist_sha256":"%s","shim_sha256":"%s","command_sha256":"%s","protected_sha256":"%s","helper_executable_sha256":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}"
}

load_migration_journal() {
  private_regular_file "$MIGRATION_JOURNAL" 600 16384 || return 1
  journal_xml="$WORK/journal.xml"
  /usr/bin/plutil -convert xml1 -o "$journal_xml" "$MIGRATION_JOURNAL" >/dev/null 2>&1 || return 1
  [ "$(grep -c '<key>' "$journal_xml")" -eq 12 ] || return 1
  journal_schema="$(/usr/bin/plutil -extract schema_version raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_phase="$(/usr/bin/plutil -extract phase raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_prior_intent="$(/usr/bin/plutil -extract prior_intent raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_queue="$(/usr/bin/plutil -extract queued_event_count raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_sequence="$(/usr/bin/plutil -extract release_sequence raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_sha="$(/usr/bin/plutil -extract release_sha raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_version="$(/usr/bin/plutil -extract companion_version raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_plist_sha="$(/usr/bin/plutil -extract plist_sha256 raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_shim_sha="$(/usr/bin/plutil -extract shim_sha256 raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_command_sha="$(/usr/bin/plutil -extract command_sha256 raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_protected_sha="$(/usr/bin/plutil -extract protected_sha256 raw -o - "$MIGRATION_JOURNAL")" || return 1
  journal_helper_sha="$(/usr/bin/plutil -extract helper_executable_sha256 raw -o - "$MIGRATION_JOURNAL")" || return 1
  [ "$journal_schema" = 1 ] && [ "$journal_sequence" = "$RELEASE_SEQUENCE" ] &&
    [ "$journal_sha" = "$RELEASE_SHA" ] && [ "$journal_version" = "$VERSION" ] || return 1
  case "$journal_prior_intent" in enabled|disabled) ;; *) return 1 ;; esac
  case "$journal_queue" in *[!0-9]*|'') return 1 ;; esac
  case "$journal_phase" in
    journal-ready|prepare|old-job-stop|launcher-directory|releases-directory|installation-directory|launcher-placement|release-placement|state-write|plist-replacement|shim-replacement|command-link-replacement|bootstrap|prepared-health|committed-pending-resume|accepted) ;;
    *) return 1 ;;
  esac
  for digest in "$journal_plist_sha" "$journal_shim_sha" "$journal_command_sha" \
    "$journal_protected_sha" "$journal_helper_sha"; do
    valid_sha256 "$digest" || return 1
  done
  expected_journal="$WORK/expected-journal.json"
  emit_migration_journal \
    "$journal_phase" "$journal_prior_intent" "$journal_queue" "$journal_sequence" \
    "$journal_sha" "$journal_version" "$journal_plist_sha" "$journal_shim_sha" \
    "$journal_command_sha" "$journal_protected_sha" "$journal_helper_sha" > "$expected_journal"
  cmp -s "$MIGRATION_JOURNAL" "$expected_journal" || return 1
  private_regular_file "$MIGRATION_DIRECTORY/old.plist" 600 1048576 || return 1
  private_regular_file "$MIGRATION_DIRECTORY/old.shim" 700 1048576 || return 1
  private_regular_file "$MIGRATION_DIRECTORY/old-command-link" 600 4096 || return 1
  private_regular_file "$MIGRATION_DIRECTORY/protected-before" 600 \
    "$MAX_PROTECTED_SNAPSHOT_BYTES" || return 1
  [ "$(file_sha256 "$MIGRATION_DIRECTORY/old.plist")" = "$journal_plist_sha" ] || return 1
  [ "$(file_sha256 "$MIGRATION_DIRECTORY/old.shim")" = "$journal_shim_sha" ] || return 1
  [ "$(file_sha256 "$MIGRATION_DIRECTORY/old-command-link")" = "$journal_command_sha" ] || return 1
  [ "$(file_sha256 "$MIGRATION_DIRECTORY/protected-before")" = "$journal_protected_sha" ] || return 1
  [ -x "$MIGRATION_HELPER_EXECUTABLE" ] && [ ! -L "$MIGRATION_HELPER_EXECUTABLE" ] || return 1
  [ "$(file_sha256 "$MIGRATION_HELPER_EXECUTABLE")" = "$journal_helper_sha" ] || return 1
  codesign --verify --strict -R="$AGENT_REQUIREMENT" "$MIGRATION_HELPER_APP" >/dev/null 2>&1 || return 1
  helper_identity="$("$MIGRATION_HELPER_EXECUTABLE" __self-check)" || return 1
  printf '%s' "$helper_identity" | grep -F "\"release_sequence\":$RELEASE_SEQUENCE" >/dev/null 2>&1 || return 1
  printf '%s' "$helper_identity" | grep -F "\"release_sha\":\"$RELEASE_SHA\"" >/dev/null 2>&1 || return 1
}

write_migration_journal() {
  phase="$1"
  temporary="$(mktemp "$MIGRATION_DIRECTORY/.journal.XXXXXX")"
  emit_migration_journal \
    "$phase" "$prior_intent" "$prior_queued_event_count" "$RELEASE_SEQUENCE" \
    "$RELEASE_SHA" "$VERSION" "$migration_plist_sha" "$migration_shim_sha" \
    "$migration_command_sha" "$migration_protected_sha" "$migration_helper_sha" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$MIGRATION_JOURNAL"
  helper="$(installer_agent_executable)" || return 1
  "$helper" __runtime-raiders-installer-sync-migration active-journal || return 1
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
  helper="$(installer_agent_executable)" || return 1
  "$helper" __runtime-raiders-installer-sync-migration active-release-state || return 1
  state_written=1
}

install_launchd_plist() {
  launch_mode="$1"
  staged_plist="$(mktemp "$WORK/plist.XXXXXX")"
  case "$launch_mode" in
    installer-prepared)
      launch_arguments="<string>$RELEASE_EXECUTABLE</string><string>daemon</string><string>__runtime-raiders-installer-migration-generation</string><string>1</string>"
      ;;
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

remove_migration_directory() {
  cleanup_context="$1"
  case "$cleanup_context" in
    accepted) cleanup_target="$MIGRATION_TOMBSTONE_DIRECTORY" ;;
    rollback) cleanup_target="$MIGRATION_ROLLBACK_TOMBSTONE" ;;
    *) return 1 ;;
  esac
  [ ! -e "$MIGRATION_TOMBSTONE_DIRECTORY" ] &&
    [ ! -L "$MIGRATION_TOMBSTONE_DIRECTORY" ] &&
    [ ! -e "$MIGRATION_ROLLBACK_TOMBSTONE" ] &&
    [ ! -L "$MIGRATION_ROLLBACK_TOMBSTONE" ] || return 1
  helper="$(installer_agent_executable)" || return 1
  durable_checkpoint "$cleanup_context-cleanup-before-rename"
  mv "$MIGRATION_DIRECTORY" "$cleanup_target" || return 1
  if [ "$helper" = "$MIGRATION_HELPER_EXECUTABLE" ]; then
    helper="$cleanup_target/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent"
  fi
  "$helper" __runtime-raiders-installer-sync-migration support-directory || return 1
  durable_checkpoint "$cleanup_context-cleanup-after-rename"
  durable_checkpoint "$cleanup_context-cleanup-before-delete"
  retire_migration_tombstone "$cleanup_context" "$cleanup_target"
}

bounded_migration_tombstone() {
  tombstone_root="$1"
  [ -d "$tombstone_root" ] && [ ! -L "$tombstone_root" ] &&
    [ "$(stat -f %u "$tombstone_root")" = "$(id -u)" ] &&
    [ "$(stat -f %Lp "$tombstone_root")" = 700 ] || return 1
  tombstone_count="$(find "$tombstone_root" -xdev -print | wc -l | tr -d ' ')" || return 1
  case "$tombstone_count" in *[!0-9]*|'') return 1 ;; esac
  [ "$tombstone_count" -le 16384 ] || return 1
  [ -z "$(find "$tombstone_root" -xdev ! -type d ! -type f -print -quit)" ] || return 1
  tombstone_bytes="$(find "$tombstone_root" -xdev -type f -exec stat -f %z {} \; | awk \
    'BEGIN { total = 0 } { total += $1; if (total > 536870912) exit 1 } END { if (total <= 536870912) print total }')" || return 1
  [ -n "$tombstone_bytes" ] || return 1
  find "$tombstone_root" -xdev -depth -mindepth 1 -print > "$WORK/migration-tombstone-entries"
  while IFS= read -r tombstone_entry; do
    [ ! -L "$tombstone_entry" ] &&
      [ "$(stat -f %u "$tombstone_entry")" = "$(id -u)" ] || return 1
    tombstone_mode="$(stat -f %Lp "$tombstone_entry")" || return 1
    case "$tombstone_mode" in [0-7][0-7][0-7]) ;; *) return 1 ;; esac
    case "$tombstone_mode" in ?[2367]?|??[2367]) return 1 ;; esac
    if [ -f "$tombstone_entry" ]; then
      [ "$(stat -f %l "$tombstone_entry")" = 1 ] || return 1
    elif [ ! -d "$tombstone_entry" ]; then
      return 1
    fi
  done < "$WORK/migration-tombstone-entries"
}

retire_migration_tombstone() {
  cleanup_context="$1"
  cleanup_target="$2"
  case "$cleanup_context:$cleanup_target" in
    "accepted:$MIGRATION_TOMBSTONE_DIRECTORY"|"rollback:$MIGRATION_ROLLBACK_TOMBSTONE") ;;
    *) return 1 ;;
  esac
  bounded_migration_tombstone "$cleanup_target" || return 1
  while IFS= read -r tombstone_entry; do
    [ ! -L "$tombstone_entry" ] &&
      [ "$(stat -f %u "$tombstone_entry")" = "$(id -u)" ] || return 1
    tombstone_mode="$(stat -f %Lp "$tombstone_entry")" || return 1
    case "$tombstone_mode" in ?[2367]?|??[2367]) return 1 ;; esac
    if [ -f "$tombstone_entry" ]; then
      [ "$(stat -f %l "$tombstone_entry")" = 1 ] || return 1
      rm -f "$tombstone_entry" || return 1
    elif [ -d "$tombstone_entry" ]; then
      rmdir "$tombstone_entry" || return 1
    else
      return 1
    fi
    durable_checkpoint "$cleanup_context-cleanup-during-delete"
  done < "$WORK/migration-tombstone-entries"
  rmdir "$cleanup_target" || return 1
  /bin/sync
}

bounded_staging_directory() {
  staging_root="$1"
  [ -d "$staging_root" ] && [ ! -L "$staging_root" ] || return 1
  [ "$(find "$staging_root" -xdev -print | wc -l | tr -d ' ')" -le 16384 ] || return 1
  [ -z "$(find "$staging_root" -xdev ! -type d ! -type f -print -quit)" ] || return 1
  staging_bytes="$(find "$staging_root" -xdev -type f -exec stat -f %z {} \; | awk \
    'BEGIN { total = 0 } { total += $1; if (total > 536870912) exit 1 } END { if (total <= 536870912) print total }')" || return 1
  [ -n "$staging_bytes" ]
}

remove_stale_migration_staging() {
  [ "$staging_pending" -eq 1 ] || return 0
  if [ -e "$MIGRATION_STAGING_TOMBSTONE" ]; then
    bounded_staging_directory "$MIGRATION_STAGING_TOMBSTONE" || return 1
    "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-sync-migration \
      staging-tombstone-tree || return 1
    durable_checkpoint staging-cleanup-before-delete
    safe_remove_created "$MIGRATION_STAGING_TOMBSTONE" || return 1
  fi
  if [ -e "$MIGRATION_STAGING_DIRECTORY" ]; then
    bounded_staging_directory "$MIGRATION_STAGING_DIRECTORY" || return 1
    "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-sync-migration \
      staging-tree || return 1
    durable_checkpoint staging-cleanup-before-rename
    mv "$MIGRATION_STAGING_DIRECTORY" "$MIGRATION_STAGING_TOMBSTONE" || return 1
    "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-sync-migration support-directory || return 1
    durable_checkpoint staging-cleanup-after-rename
    durable_checkpoint staging-cleanup-before-delete
    safe_remove_created "$MIGRATION_STAGING_TOMBSTONE" || return 1
  fi
  /bin/sync
  staging_pending=0
}

recover_interrupted_migration() {
  load_migration_journal || {
    echo "Runtime Raiders refuses an invalid migration journal" >&2
    return 1
  }
  prior_intent="$journal_prior_intent"
  prior_queued_event_count="$journal_queue"
  migration_plist_sha="$journal_plist_sha"
  migration_shim_sha="$journal_shim_sha"
  migration_command_sha="$journal_command_sha"
  migration_protected_sha="$journal_protected_sha"
  migration_helper_sha="$journal_helper_sha"
  if [ "$journal_phase" = accepted ]; then
    "$RELEASE_EXECUTABLE" __runtime-raiders-installer-status \
      candidate-resumed 1 "$journal_prior_intent" "$journal_queue" >/dev/null || return 1
    capture_protected_state "$RELEASE_EXECUTABLE" "$WORK/recovered-protected" || return 1
    cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
    remove_migration_directory accepted || return 1
    echo "Runtime Raiders installed. Run 'raiders status' to check it."
    return 2
  fi
  if [ "$journal_phase" = committed-pending-resume ]; then
    capture_protected_state "$RELEASE_EXECUTABLE" "$WORK/recovered-protected" || return 1
    cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
    start_lease "$MIGRATION_HELPER_EXECUTABLE" || return 1
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    job_absent || return 1
    write_committed_release_state || return 1
    install_launchd_plist stable || return 1
    launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || return 1
    wait_for_candidate_status candidate-prepared "$journal_prior_intent" "$journal_queue" || return 1
    capture_protected_state "$RELEASE_EXECUTABLE" "$WORK/recovered-protected" || return 1
    cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
    "$RELEASE_EXECUTABLE" __runtime-raiders-installer-resume 1 >/dev/null || return 1
    wait_for_candidate_status candidate-resumed "$journal_prior_intent" "$journal_queue" || return 1
    capture_protected_state "$RELEASE_EXECUTABLE" "$WORK/recovered-protected" || return 1
    cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
    "$RELEASE_EXECUTABLE" __runtime-raiders-installer-retire-sequence-eight-command || return 1
    write_migration_journal accepted || return 1
    close_lease
    remove_migration_directory accepted || return 1
    echo "Runtime Raiders installed. Run 'raiders status' to check it."
    return 2
  fi

  start_lease "$MIGRATION_HELPER_EXECUTABLE" || return 1
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  job_absent || return 1
  restore_copy "$MIGRATION_DIRECTORY/old.plist" "$PLIST" 600
  restore_copy "$MIGRATION_DIRECTORY/old.shim" "$SHIM" 700
  restore_copy "$MIGRATION_DIRECTORY/old-command-link" "$COMMAND_LINK_FILE" 600
  [ "$(cat "$COMMAND_LINK_FILE")" = "$LEGACY_COMMAND_PATH" ] || return 1
  if [ -e "$command_path" ] || [ -L "$command_path" ]; then
    [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ] || return 1
    rm -f "$command_path"
  fi

  safe_remove_created "$INSTALLATION_DIRECTORY" || return 1
  safe_remove_created "$RELEASE_DIRECTORY" || return 1
  safe_remove_created "$RELEASES_DIRECTORY" || return 1
  safe_remove_created "$LAUNCHER_APP" || return 1
  safe_remove_created "$LAUNCHER_DIRECTORY" || return 1
  "$MIGRATION_HELPER_EXECUTABLE" __runtime-raiders-installer-validate-legacy || return 1
  capture_protected_state "$MIGRATION_HELPER_EXECUTABLE" "$WORK/recovered-protected" || return 1
  cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || return 1
  wait_for_legacy_status "$journal_prior_intent" legacy-prepared "$journal_queue" >/dev/null 2>&1 || return 1
  capture_protected_state "$MIGRATION_HELPER_EXECUTABLE" "$WORK/recovered-protected" || return 1
  cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
  "$MIGRATION_HELPER_EXECUTABLE" __runtime-raiders-legacy-resume >/dev/null 2>&1 || return 1
  wait_for_legacy_status "$journal_prior_intent" legacy-running "$journal_queue" >/dev/null 2>&1 || return 1
  capture_protected_state "$MIGRATION_HELPER_EXECUTABLE" "$WORK/recovered-protected" || return 1
  cmp -s "$MIGRATION_DIRECTORY/protected-before" "$WORK/recovered-protected" || return 1
  close_lease
  remove_migration_directory rollback || return 1
  recovery_pending=0
}

rollback_transaction() {
  [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ] || return 0
  if [ "$migration" -eq 1 ] && load_migration_journal; then
    case "$journal_phase" in
      committed-pending-resume|accepted)
        transaction_committed=1
        return 0
        ;;
    esac
  fi
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
      if [ -e "$command_path" ] || [ -L "$command_path" ]; then
        [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ] &&
          rm -f "$command_path" || rollback_ok=0
      fi
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
      wait_for_legacy_status "$prior_intent" legacy-prepared "$prior_queued_event_count" >/dev/null 2>&1 || rollback_ok=0
      if [ -n "${helper:-}" ]; then
        "$helper" __runtime-raiders-legacy-resume >/dev/null 2>&1 || rollback_ok=0
      fi
    fi
    if [ "$protected_state_mutated" -eq 0 ]; then
      wait_for_legacy_status "$prior_intent" legacy-running "$prior_queued_event_count" >/dev/null 2>&1 || rollback_ok=0
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
  if [ "$migration" -eq 1 ] && [ "$rollback_ok" -eq 1 ]; then
    remove_migration_directory rollback || rollback_ok=0
  fi
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

if [ "$cleanup_tombstone_pending" -eq 1 ]; then
  retire_migration_tombstone "$cleanup_tombstone_context" "$cleanup_tombstone_path" || {
    echo "Runtime Raiders refuses an unsafe migration tombstone" >&2
    exit 1
  }
  cleanup_tombstone_pending=0
  if [ "$cleanup_tombstone_context" = accepted ]; then
    echo "Runtime Raiders installed. Run 'raiders status' to check it."
    trap - EXIT HUP INT TERM
    rm -rf "$WORK"
    exit 0
  fi
fi

if [ "$recovery_pending" -eq 1 ]; then
  if recover_interrupted_migration; then recovery_result=0
  else recovery_result=$?
  fi
  case "$recovery_result" in
    0) ;;
    2) trap - EXIT HUP INT TERM; rm -rf "$WORK"; exit 0 ;;
    *) exit 1 ;;
  esac
fi

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
remove_stale_migration_staging || {
  echo "Runtime Raiders could not safely retire stale migration staging" >&2
  exit 1
}
failure_checkpoint archive-verification

if [ "$migration" -eq 1 ]; then
  "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-validate-legacy || {
    echo "Runtime Raiders can migrate only the exact sequence-8 installation" >&2
    exit 1
  }
fi

failure_checkpoint enrollment-decision

if [ "$migration" -eq 1 ]; then
  legacy_snapshot="$(legacy_status_snapshot)" || {
      echo "Runtime Raiders cannot safely prepare the sequence-8 daemon" >&2
      exit 1
    }
  prior_intent="${legacy_snapshot% *}"
  prior_queued_event_count="${legacy_snapshot#* }"
  case "$prior_intent" in enabled|disabled) ;; *) echo "Runtime Raiders cannot preserve collection intent" >&2; exit 1 ;; esac
  case "$prior_queued_event_count" in *[!0-9]*|'') echo "Runtime Raiders cannot preserve queued events" >&2; exit 1 ;; esac
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
  mkdir "$MIGRATION_STAGING_DIRECTORY"
  chmod 700 "$MIGRATION_STAGING_DIRECTORY"
  durable_checkpoint journal-staging-directory
  ditto "$CANDIDATE_AGENT" "$MIGRATION_STAGING_HELPER_APP"
  cp -p "$WORK/old.plist" "$MIGRATION_STAGING_DIRECTORY/old.plist"
  cp -p "$WORK/old.shim" "$MIGRATION_STAGING_DIRECTORY/old.shim"
  cp -p "$WORK/old-command-link" "$MIGRATION_STAGING_DIRECTORY/old-command-link"
  cp -p "$WORK/protected-before" "$MIGRATION_STAGING_DIRECTORY/protected-before"
  chmod 600 "$MIGRATION_STAGING_DIRECTORY/old.plist" \
    "$MIGRATION_STAGING_DIRECTORY/old-command-link" "$MIGRATION_STAGING_DIRECTORY/protected-before"
  chmod 700 "$MIGRATION_STAGING_DIRECTORY/old.shim"
  migration_plist_sha="$(file_sha256 "$MIGRATION_STAGING_DIRECTORY/old.plist")"
  migration_shim_sha="$(file_sha256 "$MIGRATION_STAGING_DIRECTORY/old.shim")"
  migration_command_sha="$(file_sha256 "$MIGRATION_STAGING_DIRECTORY/old-command-link")"
  migration_protected_sha="$(file_sha256 "$MIGRATION_STAGING_DIRECTORY/protected-before")"
  migration_helper_sha="$(file_sha256 "$MIGRATION_STAGING_HELPER_EXECUTABLE")"
  emit_migration_journal \
    journal-ready "$prior_intent" "$prior_queued_event_count" "$RELEASE_SEQUENCE" \
    "$RELEASE_SHA" "$VERSION" "$migration_plist_sha" "$migration_shim_sha" \
    "$migration_command_sha" "$migration_protected_sha" "$migration_helper_sha" \
    > "$MIGRATION_STAGING_DIRECTORY/journal.json"
  chmod 600 "$MIGRATION_STAGING_DIRECTORY/journal.json"
  "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-sync-migration staging-tree
  durable_checkpoint journal-staging-populated
  durable_checkpoint before-journal-activation
  mv "$MIGRATION_STAGING_DIRECTORY" "$MIGRATION_DIRECTORY"
  "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-installer-sync-migration support-directory
  durable_checkpoint after-journal-activation
fi
transaction_active=1
if [ "$migration" -eq 1 ]; then durable_checkpoint journal-ready; fi

start_lease "$CANDIDATE_AGENT_EXECUTABLE" || {
  echo "Runtime Raiders installer lease did not become ready" >&2
  exit 1
}

if [ "$migration" -eq 1 ]; then
  legacy_prepare_attempted=1
  "$CANDIDATE_AGENT_EXECUTABLE" __runtime-raiders-legacy-prepare >/dev/null
  wait_for_legacy_status "$prior_intent" legacy-prepared "$prior_queued_event_count" || {
      echo "Runtime Raiders legacy daemon did not prepare" >&2
      exit 1
    }
  assert_protected_state "$CANDIDATE_AGENT_EXECUTABLE" "$WORK/protected-before" || {
    echo "Runtime Raiders protected local state changed during preparation" >&2
    exit 1
  }
  write_migration_journal prepare
  durable_checkpoint prepare
  failure_checkpoint prepare
  old_job_stop_attempted=1
  launchctl bootout "gui/$(id -u)/$LABEL"
  old_job_stopped=1
  job_absent || { echo "Runtime Raiders could not prove the old job stopped" >&2; exit 1; }
  write_migration_journal old-job-stop
  durable_checkpoint old-job-stop
  failure_checkpoint old-job-stop
else
  job_absent || { echo "Runtime Raiders refuses an unexpected launchd job" >&2; exit 1; }
fi

mkdir "$LAUNCHER_DIRECTORY"; chmod 700 "$LAUNCHER_DIRECTORY"; launcher_created=1
if [ "$migration" -eq 1 ]; then write_migration_journal launcher-directory; durable_checkpoint launcher-directory; fi
failure_checkpoint launcher-directory
mkdir "$RELEASES_DIRECTORY"; chmod 700 "$RELEASES_DIRECTORY"; releases_created=1
if [ "$migration" -eq 1 ]; then write_migration_journal releases-directory; durable_checkpoint releases-directory; fi
failure_checkpoint releases-directory
mkdir "$INSTALLATION_DIRECTORY"; chmod 700 "$INSTALLATION_DIRECTORY"; installation_created=1
if [ "$migration" -eq 1 ]; then write_migration_journal installation-directory; durable_checkpoint installation-directory; fi
failure_checkpoint installation-directory

mv "$CANDIDATE_LAUNCHER" "$LAUNCHER_APP"; launcher_placed=1
if [ "$migration" -eq 1 ]; then write_migration_journal launcher-placement; durable_checkpoint launcher-placement; fi
failure_checkpoint launcher-placement
mkdir "$RELEASE_DIRECTORY"; chmod 700 "$RELEASE_DIRECTORY"
mv "$CANDIDATE_AGENT" "$RELEASE_APP"; release_placed=1
if [ "$migration" -eq 1 ]; then write_migration_journal release-placement; durable_checkpoint release-placement; fi
failure_checkpoint release-placement

if [ "$migration" -eq 1 ]; then
  install_launchd_plist installer-prepared
else
  write_committed_release_state
  durable_checkpoint state-write
  failure_checkpoint state-write
  install_launchd_plist stable
fi
if [ "$migration" -eq 1 ]; then write_migration_journal plist-replacement; durable_checkpoint plist-replacement; fi
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
if [ "$migration" -eq 1 ]; then write_migration_journal shim-replacement; durable_checkpoint shim-replacement; fi
failure_checkpoint shim-replacement

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
staged_command_record="$(mktemp "$STATE/.command-link.XXXXXX")"
printf '%s\n' "$command_path" > "$staged_command_record"; chmod 600 "$staged_command_record"
command_mutation_started=1
mv "$staged_command_record" "$COMMAND_LINK_FILE"
rm -f "$command_path"
/bin/ln -s "$SHIM" "$command_path"
command_replaced=1
if [ "$migration" -eq 1 ]; then write_migration_journal command-link-replacement; durable_checkpoint command-link-replacement; fi
failure_checkpoint command-link-replacement

new_job_bootstrap_attempted=1
launchctl bootstrap "gui/$(id -u)" "$PLIST"; new_job_bootstrapped=1
if [ "$migration" -eq 1 ]; then write_migration_journal bootstrap; durable_checkpoint bootstrap; fi
failure_checkpoint bootstrap
wait_for_candidate_status candidate-prepared "$prior_intent" "$prior_queued_event_count" || {
  echo "Runtime Raiders candidate did not reach prepared health" >&2
  exit 1
}
assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders protected local state changed at prepared health" >&2
  exit 1
}
if [ "$migration" -eq 1 ]; then write_migration_journal prepared-health; durable_checkpoint prepared-health; fi
failure_checkpoint prepared-health
if [ "$migration" -eq 1 ]; then
  durable_checkpoint before-commit-marker
  write_migration_journal committed-pending-resume
  transaction_committed=1
  durable_checkpoint after-commit-marker
  write_committed_release_state
  durable_checkpoint state-write
  failure_checkpoint state-write
  install_launchd_plist stable
  durable_checkpoint stable-plist
  launchctl bootout "gui/$(id -u)/$LABEL"
  job_absent || {
    echo "Runtime Raiders could not prove the migration job stopped" >&2
    exit 1
  }
  durable_checkpoint stable-job-stopped
  failure_checkpoint stable-job-stopped
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  durable_checkpoint stable-job-bootstrapped
  failure_checkpoint stable-job-bootstrapped
  wait_for_candidate_status candidate-prepared "$prior_intent" "$prior_queued_event_count" || {
    echo "Runtime Raiders stable job did not reach prepared health" >&2
    exit 1
  }
  assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
    echo "Runtime Raiders protected local state changed during stable job reload" >&2
    exit 1
  }
  durable_checkpoint stable-job-prepared
  failure_checkpoint stable-job-prepared
fi
"$RELEASE_EXECUTABLE" __runtime-raiders-installer-resume 1 >/dev/null
if [ "$migration" -eq 1 ]; then durable_checkpoint after-candidate-resume; fi
wait_for_candidate_status candidate-resumed "$prior_intent" "$prior_queued_event_count" || {
  echo "Runtime Raiders candidate did not restore collection intent" >&2
  exit 1
}
assert_protected_state "$RELEASE_EXECUTABLE" "$WORK/protected-before" || {
  echo "Runtime Raiders protected local state changed after resume" >&2
  exit 1
}
if [ "$migration" -eq 1 ]; then
  "$RELEASE_EXECUTABLE" __runtime-raiders-installer-retire-sequence-eight-command
  durable_checkpoint legacy-command-retired
  write_migration_journal accepted
  durable_checkpoint acceptance-mark
fi
close_lease
transaction_committed=1
if [ "$migration" -eq 1 ]; then remove_migration_directory accepted; fi
echo "Runtime Raiders installed. Run 'raiders status' to check it."
