#!/bin/sh
set -eu

COMPANION_VERSION='__RUNTIME_RAIDERS_COMPANION_VERSION__'
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'
ARCHIVE_SHA256='__RUNTIME_RAIDERS_ARCHIVE_SHA256__'
ARCHIVE_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
LOCAL_ARCHIVE="${RUNTIME_RAIDERS_LOCAL_ARCHIVE:-}"

ENROLL_URL='https://raiders.redlattice.com/api/raiders/enroll'
ORIGIN='https://raiders.redlattice.com'
APP_BUNDLE_ID='com.redlattice.runtime-raiders'
MANAGED_LABEL='com.redlattice.runtime-raiders.agent'
MANAGED_PLIST_NAME="$MANAGED_LABEL.plist"
LEGACY_LABEL='com.redlattice.runtime-raiders-agent'
APP_REQUIREMENT='identifier "com.redlattice.runtime-raiders" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

usage() {
  echo 'usage: curl -fsSL https://raiders.redlattice.com/install.sh | sh' >&2
  exit 64
}

[ "$#" -eq 0 ] || usage
[ "$ARCHIVE_URL" = "$ORIGIN/downloads/runtime-raiders-agent.zip" ] &&
  [ "$ENROLL_URL" = "$ORIGIN/api/raiders/enroll" ] || exit 1
case "$TEAM_ID" in *[!A-Z0-9]*|'') exit 1;; esac
[ "$(printf '%s' "$TEAM_ID" | /usr/bin/wc -c | /usr/bin/tr -d ' ')" -eq 10 ] || exit 1
case "$COMPANION_VERSION" in *[!0-9A-Za-z._-]*|'') exit 1;; esac
case "$ARCHIVE_SHA256" in *[!0-9a-f]*|'') exit 1;; esac
[ "$(printf '%s' "$ARCHIVE_SHA256" | /usr/bin/wc -c | /usr/bin/tr -d ' ')" -eq 64 ] || exit 1

umask 077
OWNER="$(/usr/bin/id -u)"
SUPPORT="$HOME/Library/Application Support/Runtime Raiders"
STATE="$SUPPORT/state"
OUTBOX="$SUPPORT/outbox"
APP="$SUPPORT/Runtime Raiders.app"
LEGACY_APP="$SUPPORT/Runtime Raiders Agent.app"
AGENT="$APP/Contents/MacOS/runtime-raiders-agent"
SHIM="$SUPPORT/raiders"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LEGACY_PLIST="$LAUNCH_AGENTS/$LEGACY_LABEL.plist"
COMMAND_DIRECTORY="$HOME/.local/bin"
COMMAND="$COMMAND_DIRECTORY/raiders"
ENROLLMENT="$STATE/enrollment.json"
RECOVERY_JOURNAL="$STATE/re-enrollment.json"
RELEASES="$SUPPORT/releases"
INSTALLATION="$SUPPORT/installation"
LAUNCHER="$SUPPORT/launcher"

refuse_symlink() {
  [ ! -L "$1" ] || {
    echo "Runtime Raiders refuses symlinked path: $1" >&2
    exit 1
  }
}

for owned_path in \
  "$HOME/Library" "$HOME/Library/Application Support" "$SUPPORT" "$STATE" "$OUTBOX" \
  "$APP" "$LEGACY_APP" "$LAUNCH_AGENTS" "$LEGACY_PLIST" "$SHIM" "$HOME/.local" "$COMMAND_DIRECTORY" \
  "$RELEASES" "$INSTALLATION" "$LAUNCHER" "$RECOVERY_JOURNAL"; do
  refuse_symlink "$owned_path"
done

if [ -d "$RELEASES" ] &&
   [ -n "$(/usr/bin/find "$RELEASES" -mindepth 1 -maxdepth 1 -name 'sequence-16-*' -print -quit 2>/dev/null)" ]; then
  echo 'Runtime Raiders sequence-16 private layout requires fresh canary cleanup; it is not migrated by this installer.' >&2
  exit 1
fi
if [ -e "$RELEASES" ] || [ -e "$INSTALLATION" ] || [ -e "$LAUNCHER" ]; then
  echo 'Runtime Raiders refuses an obsolete versioned installation; perform the approved one-time cleanup first.' >&2
  exit 1
fi
if [ -e "$LEGACY_APP" ]; then
  echo 'The obsolete Runtime Raiders Agent.app canary must be removed before installing Runtime Raiders.' >&2
  exit 1
fi

for owned_directory in \
  "$HOME/Library" "$HOME/Library/Application Support" "$SUPPORT" "$STATE" "$OUTBOX" \
  "$LAUNCH_AGENTS" "$HOME/.local" "$COMMAND_DIRECTORY"; do
  if [ -e "$owned_directory" ] && {
    [ ! -d "$owned_directory" ] ||
      [ "$(/usr/bin/stat -f %u "$owned_directory")" != "$OWNER" ];
  }; then
    echo "Runtime Raiders refuses unsafe directory: $owned_directory" >&2
    exit 1
  fi
done
if [ -e "$APP" ] && {
  [ ! -d "$APP" ] || [ "$(/usr/bin/stat -f %u "$APP")" != "$OWNER" ];
}; then
  echo "Runtime Raiders refuses unsafe app path: $APP" >&2
  exit 1
fi
for owned_file in "$LEGACY_PLIST" "$SHIM"; do
  if [ -e "$owned_file" ] && {
    [ ! -f "$owned_file" ] ||
      [ "$(/usr/bin/stat -f %u "$owned_file")" != "$OWNER" ];
  }; then
    echo "Runtime Raiders refuses unsafe file: $owned_file" >&2
    exit 1
  fi
done
if [ -e "$COMMAND" ] || [ -L "$COMMAND" ]; then
  [ -L "$COMMAND" ] && [ "$(/usr/bin/readlink "$COMMAND")" = "$SHIM" ] || {
    echo "Runtime Raiders refuses existing command path: $COMMAND" >&2
    exit 1
  }
fi

plist_has_exact_keys() {
  schema_file=$1
  schema_count=$2
  shift 2
  schema_xml="$(/usr/bin/plutil -convert xml1 -o - "$schema_file")" || return 1
  actual_count="$(printf '%s\n' "$schema_xml" | /usr/bin/grep -c '<key>')"
  [ "$actual_count" -eq "$schema_count" ] || return 1
  for schema_key in "$@"; do
    printf '%s\n' "$schema_xml" | /usr/bin/grep -F "<key>$schema_key</key>" >/dev/null || return 1
  done
}

plist_value_has_type() {
  type_file=$1
  type_key=$2
  type_name=$3
  type_xml="$(/usr/bin/plutil -extract "$type_key" xml1 -o - "$type_file")" || return 1
  printf '%s\n' "$type_xml" | /usr/bin/grep -F "<$type_name>" >/dev/null
}

valid_legacy_plist() {
  legacy_plist=$1
  plist_has_exact_keys "$legacy_plist" 6 \
    Label AssociatedBundleIdentifiers ProgramArguments RunAtLoad KeepAlive ProcessType &&
    [ "$(/usr/bin/plutil -extract Label raw -o - "$legacy_plist")" = "$LEGACY_LABEL" ] &&
    [ "$(/usr/bin/plutil -extract AssociatedBundleIdentifiers.0 raw -o - "$legacy_plist")" = \
      "$LEGACY_LABEL" ] &&
    ! /usr/bin/plutil -extract AssociatedBundleIdentifiers.1 raw -o - "$legacy_plist" >/dev/null 2>&1 &&
    [ "$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$legacy_plist")" = "$AGENT" ] &&
    [ "$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$legacy_plist")" = daemon ] &&
    ! /usr/bin/plutil -extract ProgramArguments.2 raw -o - "$legacy_plist" >/dev/null 2>&1 &&
    [ "$(/usr/bin/plutil -extract RunAtLoad raw -expect bool -o - "$legacy_plist")" = true ] &&
    [ "$(/usr/bin/plutil -extract KeepAlive raw -expect bool -o - "$legacy_plist")" = true ] &&
    [ "$(/usr/bin/plutil -extract ProcessType raw -o - "$legacy_plist")" = Background ]
}

reject_existing_layout() {
  echo 'Runtime Raiders refuses a partial, mixed, or unsupported existing installation.' >&2
  exit 1
}

app_present=0
legacy_plist_present=0
shim_present=0
existing_bundle_version=''
[ ! -e "$APP" ] || app_present=1
[ ! -e "$LEGACY_PLIST" ] || legacy_plist_present=1
[ ! -e "$SHIM" ] || shim_present=1

if [ "$app_present" -eq 0 ] && [ "$legacy_plist_present" -eq 0 ] && [ "$shim_present" -eq 0 ]; then
  existing_form=fresh
elif [ "$app_present" -eq 1 ] && [ "$legacy_plist_present" -eq 1 ] && [ "$shim_present" -eq 1 ]; then
  existing_info="$APP/Contents/Info.plist"
  [ -f "$existing_info" ] && [ ! -L "$existing_info" ] &&
    [ -f "$AGENT" ] && [ ! -L "$AGENT" ] && [ -x "$AGENT" ] &&
    [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$existing_info")" = "$LEGACY_LABEL" ] &&
    [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$existing_info")" = 0.4.2 ] &&
    [ "$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$existing_info")" = 0.4.2 ] &&
    valid_legacy_plist "$LEGACY_PLIST" || reject_existing_layout
  existing_bundle_version=0.4.2
  existing_form=legacy
elif [ "$app_present" -eq 1 ] && [ "$legacy_plist_present" -eq 0 ] && [ "$shim_present" -eq 1 ]; then
  existing_info="$APP/Contents/Info.plist"
  [ -f "$existing_info" ] && [ ! -L "$existing_info" ] &&
    [ -f "$AGENT" ] && [ ! -L "$AGENT" ] && [ -x "$AGENT" ] &&
    [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$existing_info")" = "$APP_BUNDLE_ID" ] &&
    existing_bundle_version="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$existing_info")" &&
    [ -n "$existing_bundle_version" ] ||
    reject_existing_layout
  existing_form=managed
else
  reject_existing_layout
fi

/bin/mkdir -p "$STATE" "$OUTBOX" "$COMMAND_DIRECTORY"
[ -e "$SUPPORT" ] || exit 1

is_bounded_json_dictionary() {
  json_file=$1
  json_size="$(/usr/bin/stat -f %z "$json_file")" || return 1
  [ "$json_size" -gt 0 ] && [ "$json_size" -le 65536 ] || return 1
  LC_ALL=C /usr/bin/awk '
    match($0, /[^[:space:]]/) { found = 1; valid = substr($0, RSTART, 1) == "{"; exit }
    END { if (!found || !valid) exit 1 }
  ' "$json_file"
}

valid_uuid() {
  uuid_value=$1
  case "$uuid_value" in
    ????????-????-????-????-????????????) ;;
    *) return 1;;
  esac
  uuid_hex="$(printf '%s' "$uuid_value" | /usr/bin/tr -d '-')"
  case "$uuid_hex" in *[!A-Fa-f0-9]*|'') return 1;; esac
  [ "${#uuid_hex}" -eq 32 ]
}

valid_enrollment_values() {
  values_file=$1
  enrollment_device_id="$(/usr/bin/plutil -extract device_id raw -o - "$values_file")" &&
    enrollment_token="$(/usr/bin/plutil -extract device_token raw -o - "$values_file")" &&
    enrollment_secret="$(/usr/bin/plutil -extract dedupe_secret raw -o - "$values_file")" &&
    enrollment_server="$(/usr/bin/plutil -extract server_url raw -o - "$values_file")" &&
    enrollment_cutover="$(/usr/bin/plutil -extract cutover_at raw -o - "$values_file")" &&
    enrollment_surfaces="$(/usr/bin/plutil -extract enabled_surfaces json -o - "$values_file")" || return 1
  valid_uuid "$enrollment_device_id" && [ "$enrollment_server" = "$ORIGIN" ] || return 1
  case "$enrollment_token" in *[!A-Za-z0-9_-]*|'') return 1;; esac
  case "$enrollment_secret" in *[!0123456789abcdef]*|'') return 1;; esac
  case "$enrollment_cutover" in *[!0123456789]*|'') return 1;; esac
  [ "${#enrollment_token}" -eq 43 ] && [ "${#enrollment_secret}" -eq 64 ] &&
    [ "$enrollment_cutover" -le 9007199254740991 ] || return 1
  case "$enrollment_surfaces" in
    '["codex_desktop"]'|'["codex_cli"]'|'["codex_desktop","codex_cli"]'|'["codex_cli","codex_desktop"]') ;;
    *) return 1;;
  esac
}

validate_enrollment_contents() {
  enrollment_file=$1
  is_bounded_json_dictionary "$enrollment_file" &&
    plist_has_exact_keys "$enrollment_file" 7 \
    version device_id device_token dedupe_secret server_url cutover_at enabled_surfaces &&
    plist_value_has_type "$enrollment_file" version integer &&
    plist_value_has_type "$enrollment_file" device_id string &&
    plist_value_has_type "$enrollment_file" device_token string &&
    plist_value_has_type "$enrollment_file" dedupe_secret string &&
    plist_value_has_type "$enrollment_file" server_url string &&
    plist_value_has_type "$enrollment_file" cutover_at integer &&
    plist_value_has_type "$enrollment_file" enabled_surfaces array || return 1
  enrollment_version="$(/usr/bin/plutil -extract version raw -o - "$enrollment_file")" || return 1
  [ "$enrollment_version" = 1 ] && valid_enrollment_values "$enrollment_file"
}

validate_enrollment() {
  [ -f "$ENROLLMENT" ] && [ ! -L "$ENROLLMENT" ] &&
    [ "$(/usr/bin/stat -f %u "$ENROLLMENT")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f %Lp "$ENROLLMENT")" = 600 ] &&
    [ "$(/usr/bin/stat -f %l "$ENROLLMENT")" = 1 ] &&
    validate_enrollment_contents "$ENROLLMENT"
}

validate_recovery_journal_contents() {
  journal_file=$1
  journal_size="$(/usr/bin/stat -f %z "$journal_file")" || return 1
  [ "$journal_size" -gt 0 ] && [ "$journal_size" -le 16384 ] || return 1
  is_bounded_json_dictionary "$journal_file" &&
    plist_has_exact_keys "$journal_file" 7 \
      version operation_id replacement_device_id replacement_device_token \
      companion_version queue_disposition phase &&
    plist_value_has_type "$journal_file" version integer &&
    plist_value_has_type "$journal_file" operation_id string &&
    plist_value_has_type "$journal_file" replacement_device_id string &&
    plist_value_has_type "$journal_file" replacement_device_token string &&
    plist_value_has_type "$journal_file" companion_version string &&
    plist_value_has_type "$journal_file" queue_disposition string &&
    plist_value_has_type "$journal_file" phase string || return 1
  journal_version="$(/usr/bin/plutil -extract version raw -o - "$journal_file")" &&
    journal_operation_id="$(/usr/bin/plutil -extract operation_id raw -o - "$journal_file")" &&
    journal_replacement_device_id="$(/usr/bin/plutil -extract replacement_device_id raw -o - "$journal_file")" &&
    journal_replacement_token="$(/usr/bin/plutil -extract replacement_device_token raw -o - "$journal_file")" &&
    journal_companion_version="$(/usr/bin/plutil -extract companion_version raw -o - "$journal_file")" &&
    journal_queue_disposition="$(/usr/bin/plutil -extract queue_disposition raw -o - "$journal_file")" &&
    journal_phase="$(/usr/bin/plutil -extract phase raw -o - "$journal_file")" || return 1
  valid_uuid "$journal_operation_id" &&
    valid_uuid "$journal_replacement_device_id" &&
    [ "$journal_version" = 1 ] || return 1
  case "$journal_replacement_token" in *[!A-Za-z0-9_-]*|'') return 1;; esac
  [ "${#journal_replacement_token}" -eq 43 ] || return 1
  journal_companion_version_bytes="$(printf '%s' "$journal_companion_version" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
  [ "$journal_companion_version_bytes" -ge 1 ] && [ "$journal_companion_version_bytes" -le 100 ] || return 1
  case "$journal_queue_disposition" in delivered|discarded|empty) ;; *) return 1;; esac
  case "$journal_phase" in
    replacementPrepared|serverCommitted|configurationInstalled|collectorReset|agentRegistered) ;;
    *) return 1;;
  esac
}

validate_recovery_journal() {
  [ -f "$RECOVERY_JOURNAL" ] && [ ! -L "$RECOVERY_JOURNAL" ] &&
    [ "$(/usr/bin/stat -f %u "$RECOVERY_JOURNAL")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f %Lp "$RECOVERY_JOURNAL")" = 600 ] &&
    [ "$(/usr/bin/stat -f %l "$RECOVERY_JOURNAL")" = 1 ] &&
    validate_recovery_journal_contents "$RECOVERY_JOURNAL"
}

validate_enrollment_response() {
  response_file=$1
  [ -f "$response_file" ] && [ ! -L "$response_file" ] &&
    is_bounded_json_dictionary "$response_file" &&
    plist_has_exact_keys "$response_file" 5 \
      device_token dedupe_secret server_url cutover_at enabled_surfaces &&
    plist_value_has_type "$response_file" device_token string &&
    plist_value_has_type "$response_file" dedupe_secret string &&
    plist_value_has_type "$response_file" server_url string &&
    plist_value_has_type "$response_file" cutover_at integer &&
    plist_value_has_type "$response_file" enabled_surfaces array
}

collection_is_conclusively_disabled() {
  collection_status_file=$1
  [ -f "$collection_status_file" ] && [ ! -L "$collection_status_file" ] &&
    is_bounded_json_dictionary "$collection_status_file" || return 1
  collection_enabled="$(/usr/bin/plutil -extract enabled raw -expect bool -o - \
    "$collection_status_file")" &&
    collection_activation="$(/usr/bin/plutil -extract activationState raw -expect string -o - \
      "$collection_status_file")" &&
    collection_persisted="$(/usr/bin/plutil -extract persistedState raw -expect string -o - \
      "$collection_status_file")" || return 1
  [ "$collection_enabled" = false ] || return 1
  [ "$collection_activation" = disabled ] || return 1
  case "$collection_persisted" in
    missing|disabled) return 0;;
    *) return 1;;
  esac
}

installation_status_is_ready() {
  readiness_status_file=$1
  readiness_expected_version=$2
  readiness_expected_daemon=$3
  collection_is_conclusively_disabled "$readiness_status_file" || return 1
  readiness_daemon="$(/usr/bin/plutil -extract daemonRunning raw -expect bool -o - \
    "$readiness_status_file")" &&
    readiness_version="$(/usr/bin/plutil -extract installedCompanionVersion raw -expect string -o - \
      "$readiness_status_file")" || return 1
  [ "$readiness_daemon" = "$readiness_expected_daemon" ] &&
    [ "$readiness_version" = "$readiness_expected_version" ]
}

wait_for_installation_status() {
  readiness_command=$1
  readiness_output=$2
  readiness_expected_version=$3
  readiness_expected_daemon=$4
  readiness_started="$(/bin/date +%s)" || return 1
  readiness_deadline=$((readiness_started + 30))
  while :; do
    if "$readiness_command" status --json > "$readiness_output" &&
       installation_status_is_ready "$readiness_output" \
         "$readiness_expected_version" "$readiness_expected_daemon"; then
      return 0
    fi
    readiness_now="$(/bin/date +%s)" || return 1
    [ "$readiness_now" -lt "$readiness_deadline" ] || return 1
    /bin/sleep 1 || return 1
  done
}

print_installation_status_diagnostic() {
  diagnostic_status_file=$1
  diagnostic_expected_version=$2
  diagnostic_collection=unknown
  diagnostic_activation=unknown
  diagnostic_persisted=unknown
  diagnostic_daemon=unknown
  diagnostic_version=unavailable

  if diagnostic_enabled="$(/usr/bin/plutil -extract enabled raw -expect bool -o - \
       "$diagnostic_status_file" 2>/dev/null)"; then
    case "$diagnostic_enabled" in
      false) diagnostic_collection=off;;
      true) diagnostic_collection=on;;
    esac
  fi
  if diagnostic_value="$(/usr/bin/plutil -extract activationState raw -expect string -o - \
       "$diagnostic_status_file" 2>/dev/null)"; then
    case "$diagnostic_value" in
      disabled|preparing|ready) diagnostic_activation=$diagnostic_value;;
    esac
  fi
  if diagnostic_value="$(/usr/bin/plutil -extract persistedState raw -expect string -o - \
       "$diagnostic_status_file" 2>/dev/null)"; then
    case "$diagnostic_value" in
      missing|disabled|enabled|invalid) diagnostic_persisted=$diagnostic_value;;
    esac
  fi
  if diagnostic_value="$(/usr/bin/plutil -extract daemonRunning raw -expect bool -o - \
       "$diagnostic_status_file" 2>/dev/null)"; then
    case "$diagnostic_value" in
      true) diagnostic_daemon=running;;
      false) diagnostic_daemon=stopped;;
    esac
  fi
  if diagnostic_value="$(/usr/bin/plutil -extract installedCompanionVersion raw -expect string -o - \
       "$diagnostic_status_file" 2>/dev/null)"; then
    if [ "$diagnostic_value" = "$diagnostic_expected_version" ]; then
      diagnostic_version=expected
    else
      diagnostic_version=unexpected
    fi
  fi

  printf 'Runtime Raiders readiness at timeout: collection=%s activation=%s persisted=%s daemon=%s version=%s.\n' \
    "$diagnostic_collection" "$diagnostic_activation" "$diagnostic_persisted" \
    "$diagnostic_daemon" "$diagnostic_version"
}

legacy_job_registration_state() {
  if /bin/launchctl print "gui/$OWNER/$LEGACY_LABEL" >/dev/null 2>&1; then
    printf 'registered\n'
    return 0
  else
    legacy_inspection_status=$?
  fi
  if [ "$legacy_inspection_status" -eq 113 ]; then
    printf 'absent\n'
    return 0
  fi
  return 1
}

has_enrollment=0
if [ -e "$ENROLLMENT" ] || [ -L "$ENROLLMENT" ]; then
  refuse_symlink "$ENROLLMENT"
  [ -f "$ENROLLMENT" ] &&
    [ "$(/usr/bin/stat -f %u "$ENROLLMENT")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f %Lp "$ENROLLMENT")" = 600 ] || {
    echo 'Runtime Raiders refuses unsafe existing enrollment.' >&2
    exit 1
  }
  if validate_enrollment; then
    has_enrollment=1
  else
    echo 'Runtime Raiders refuses an invalid existing enrollment.' >&2
    exit 1
  fi
fi

has_recovery_journal=0
if [ -e "$RECOVERY_JOURNAL" ] || [ -L "$RECOVERY_JOURNAL" ]; then
  refuse_symlink "$RECOVERY_JOURNAL"
  [ -f "$RECOVERY_JOURNAL" ] &&
    [ "$(/usr/bin/stat -f %u "$RECOVERY_JOURNAL")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f %Lp "$RECOVERY_JOURNAL")" = 600 ] || {
    echo 'Runtime Raiders refuses unsafe existing recovery state.' >&2
    exit 1
  }
  if validate_recovery_journal; then
    has_recovery_journal=1
  else
    echo 'Runtime Raiders refuses invalid existing recovery state.' >&2
    exit 1
  fi
fi

if [ "$has_recovery_journal" -eq 1 ] && [ "$has_enrollment" -eq 0 ]; then
  echo 'Runtime Raiders refuses recovery state without an existing enrollment.' >&2
  exit 1
fi

if [ "$existing_form" = managed ]; then
  existing_managed_status="$("$AGENT" __runtime-raiders-managed-agent status)" || reject_existing_layout
  if [ "$has_recovery_journal" -eq 1 ]; then
    [ "$existing_managed_status" = not-registered ] || reject_existing_layout
  else
    [ "$existing_managed_status" = enabled ] || reject_existing_layout
  fi
fi

fresh_enrollment=0
if [ "$has_enrollment" -eq 0 ] && [ "$has_recovery_journal" -eq 0 ]; then fresh_enrollment=1; fi

WORK="$(/usr/bin/mktemp -d "$SUPPORT/.runtime-raiders-install.XXXXXX")"
transaction_active=0
transaction_committed=0
legacy_stop_attempted=0
legacy_initial_registration_known=0
legacy_was_registered=0
old_managed_unregister_attempted=0
new_managed_register_attempted=0
rollback_new_unregister_attempted=0
rollback_old_register_attempted=0
original_app=0
original_legacy_plist=0
original_shim=0
original_command=0
[ ! -e "$APP" ] || original_app=1
[ ! -e "$LEGACY_PLIST" ] || original_legacy_plist=1
[ ! -e "$SHIM" ] || original_shim=1
[ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ] || original_command=1
tty_changed=0
tty_state=''
lifecycle_lock_active=0
lifecycle_lock_pid=''
lifecycle_lock_ready="$WORK/lifecycle-lock.ready"
lifecycle_lock_fifo="$WORK/lifecycle-lock.fifo"
lifecycle_lock_ready_bytes=0

restore_tty() {
  if [ "$tty_changed" -eq 1 ]; then
    /bin/stty "$tty_state" < /dev/tty 2>/dev/null || true
    tty_changed=0
  fi
}

release_lifecycle_lock() {
  [ "$lifecycle_lock_active" -eq 1 ] || return 0
  lifecycle_lock_release_ok=1
  lifecycle_lock_expected_bytes=$((lifecycle_lock_ready_bytes + 9))
  if ! printf 'release\n' >&9 ||
     ! wait_for_lifecycle_lock_response "$lifecycle_lock_expected_bytes" released 0; then
    lifecycle_lock_release_ok=0
  fi
  exec 9>&-
  lifecycle_lock_wait_status=0
  wait "$lifecycle_lock_pid" || lifecycle_lock_wait_status=$?
  lifecycle_lock_active=0
  lifecycle_lock_pid=''
  /bin/rm -f "$lifecycle_lock_ready" "$lifecycle_lock_fifo" || return 1
  [ "$lifecycle_lock_release_ok" -eq 1 ] && [ "$lifecycle_lock_wait_status" -eq 0 ]
}

wait_for_lifecycle_lock_response() {
  lifecycle_lock_expected_bytes=$1
  lifecycle_lock_expected_line=$2
  lifecycle_lock_require_alive=${3:-1}
  lifecycle_lock_response_attempt=0
  while [ "$lifecycle_lock_response_attempt" -lt 100 ]; do
    if [ "$(/usr/bin/stat -f %z "$lifecycle_lock_ready" 2>/dev/null || true)" = \
         "$lifecycle_lock_expected_bytes" ] &&
       [ "$(/usr/bin/tail -n 1 "$lifecycle_lock_ready" 2>/dev/null || true)" = \
         "$lifecycle_lock_expected_line" ]; then
      if [ "$lifecycle_lock_require_alive" -eq 0 ] ||
         kill -0 "$lifecycle_lock_pid" 2>/dev/null; then return 0; fi
    fi
    if [ "$lifecycle_lock_require_alive" -eq 1 ] &&
       ! kill -0 "$lifecycle_lock_pid" 2>/dev/null; then break; fi
    lifecycle_lock_response_attempt=$((lifecycle_lock_response_attempt + 1))
    /bin/sleep 0.01 || break
  done
  return 1
}

prove_lifecycle_lock() {
  [ "$lifecycle_lock_active" -eq 1 ] && kill -0 "$lifecycle_lock_pid" 2>/dev/null || return 1
  lifecycle_lock_expected_bytes=$((lifecycle_lock_ready_bytes + 5))
  printf 'held\n' >&9 || return 1
  wait_for_lifecycle_lock_response "$lifecycle_lock_expected_bytes" held 1 || return 1
  lifecycle_lock_ready_bytes=$lifecycle_lock_expected_bytes
}

acquire_lifecycle_lock() {
  lock_agent=$1
  /usr/bin/mkfifo "$lifecycle_lock_fifo" || return 1
  /bin/chmod 600 "$lifecycle_lock_fifo" || return 1
  : > "$lifecycle_lock_ready" || return 1
  /bin/chmod 600 "$lifecycle_lock_ready" || return 1
  "$lock_agent" __runtime-raiders-lifecycle-lock-hold "$lock_agent" \
    < "$lifecycle_lock_fifo" > "$lifecycle_lock_ready" 2>/dev/null &
  lifecycle_lock_pid=$!
  exec 9>"$lifecycle_lock_fifo"
  lifecycle_lock_attempt=0
  while [ "$lifecycle_lock_attempt" -lt 100 ]; do
    if [ -f "$lifecycle_lock_ready" ] && [ ! -L "$lifecycle_lock_ready" ] &&
       [ "$(/usr/bin/stat -f %u "$lifecycle_lock_ready")" = "$OWNER" ] &&
       [ "$(/usr/bin/stat -f %Lp "$lifecycle_lock_ready")" = 600 ] &&
       [ "$(/usr/bin/stat -f %l "$lifecycle_lock_ready")" = 1 ] &&
       [ "$(/usr/bin/stat -f %z "$lifecycle_lock_ready")" = 7 ] &&
       [ "$(/bin/cat "$lifecycle_lock_ready")" = locked ] &&
       kill -0 "$lifecycle_lock_pid" 2>/dev/null; then
      lifecycle_lock_active=1
      lifecycle_lock_ready_bytes=7
      /bin/rm -f "$lifecycle_lock_fifo" || return 1
      return 0
    fi
    if ! kill -0 "$lifecycle_lock_pid" 2>/dev/null; then break; fi
    lifecycle_lock_attempt=$((lifecycle_lock_attempt + 1))
    /bin/sleep 0.01 || break
  done
  exec 9>&-
  wait "$lifecycle_lock_pid" 2>/dev/null || true
  lifecycle_lock_pid=''
  /bin/rm -f "$lifecycle_lock_ready" "$lifecycle_lock_fifo" || true
  return 1
}

restore_target() {
  restore_stable=$1
  restore_backup=$2
  restore_failed=$3
  restore_original=$4
  if [ "$restore_original" -eq 1 ]; then
    if [ -e "$restore_backup" ]; then
      if [ -e "$restore_stable" ]; then
        /bin/mv "$restore_stable" "$restore_failed" || return 1
      fi
      /bin/mv "$restore_backup" "$restore_stable" || return 1
    else
      [ -e "$restore_stable" ] || return 1
    fi
  elif [ -e "$restore_stable" ]; then
    if [ -d "$restore_stable" ]; then
      /bin/rm -rf "$restore_stable" || return 1
    else
      /bin/rm -f "$restore_stable" || return 1
    fi
  fi
}

rollback() {
  rollback_status=$?
  trap - EXIT HUP INT TERM
  restore_tty
  restoration_complete=1
  original_registration_restored=0
  if [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ]; then
    new_registration_compensated=1
    if [ "$new_managed_register_attempted" -eq 1 ]; then
      new_registration_compensated=0
      rollback_new_unregister_attempted=1
      if rollback_managed_result="$("$AGENT" __runtime-raiders-managed-agent unregister)"; then
        if [ "$rollback_managed_result" = not-registered ]; then
          new_registration_compensated=1
        fi
      fi
      [ "$new_registration_compensated" -eq 1 ] || restoration_complete=0
    fi
    app_restored=1
    if ! restore_target "$APP" "$WORK/old.app" "$WORK/failed.app" "$original_app"; then
      restoration_complete=0
      app_restored=0
    fi
    if [ "$original_legacy_plist" -eq 1 ] && [ -e "$WORK/old.plist" ]; then
      /bin/mkdir -p "$LAUNCH_AGENTS" || restoration_complete=0
    fi
    legacy_plist_restored=1
    if ! restore_target "$LEGACY_PLIST" "$WORK/old.plist" \
      "$WORK/failed.plist" "$original_legacy_plist"; then
      restoration_complete=0
      legacy_plist_restored=0
    fi
    shim_restored=1
    if ! restore_target "$SHIM" "$WORK/old.shim" "$WORK/failed.shim" "$original_shim"; then
      restoration_complete=0
      shim_restored=0
    fi
    command_restored=1
    if [ "$original_command" -eq 0 ] && { [ -e "$COMMAND" ] || [ -L "$COMMAND" ]; }; then
      if ! /bin/rm -f "$COMMAND"; then
        restoration_complete=0
        command_restored=0
      fi
    elif [ "$original_command" -eq 1 ]; then
      [ -L "$COMMAND" ] && [ "$(/usr/bin/readlink "$COMMAND")" = "$SHIM" ] ||
        {
          restoration_complete=0
          command_restored=0
        }
    fi
    prior_service_restored=1
    case "$existing_form" in
      legacy)
        prior_service_restored=0
        if [ "$legacy_initial_registration_known" -eq 1 ] &&
           restored_legacy_state="$(legacy_job_registration_state)"; then
          if [ "$legacy_was_registered" -eq 1 ]; then
            if [ "$restored_legacy_state" = absent ] &&
               [ "$app_restored" -eq 1 ] && [ "$legacy_plist_restored" -eq 1 ] &&
               /bin/launchctl bootstrap "gui/$OWNER" "$LEGACY_PLIST" >/dev/null 2>&1; then
              restored_legacy_state="$(legacy_job_registration_state)" || restored_legacy_state=unknown
            fi
            [ "$restored_legacy_state" = registered ] && prior_service_restored=1
          elif [ "$restored_legacy_state" = absent ]; then
            prior_service_restored=1
          fi
        fi;;
      managed)
        if [ "$old_managed_unregister_attempted" -eq 1 ]; then
          prior_service_restored=0
          if [ "$app_restored" -eq 1 ] && [ -x "$AGENT" ]; then
            rollback_old_register_attempted=1
            if restored_managed_result="$("$AGENT" __runtime-raiders-managed-agent register)" &&
               [ "$restored_managed_result" = enabled ]; then
              restored_managed_status="$("$AGENT" __runtime-raiders-managed-agent status)" ||
                restored_managed_status=''
              [ "$restored_managed_status" = enabled ] && prior_service_restored=1
            fi
          fi
        fi;;
    esac
    [ "$prior_service_restored" -eq 1 ] || restoration_complete=0

    restored_collection_disabled=1
    if [ "$existing_form" != fresh ]; then
      restored_collection_disabled=0
      restored_status_file="$WORK/restored-status.json"
      restored_expected_daemon=true
      if [ "$existing_form" = legacy ] && [ "$legacy_was_registered" -eq 0 ]; then
        restored_expected_daemon=false
      fi
      if [ "$app_restored" -eq 1 ] && [ "$shim_restored" -eq 1 ] &&
         wait_for_installation_status "$SHIM" "$restored_status_file" \
           "$existing_bundle_version" "$restored_expected_daemon"; then
        restored_collection_disabled=1
      fi
      [ "$restored_collection_disabled" -eq 1 ] || restoration_complete=0
    fi

    if [ "$app_restored" -eq 1 ] && [ "$legacy_plist_restored" -eq 1 ] &&
       [ "$shim_restored" -eq 1 ] && [ "$command_restored" -eq 1 ] &&
       [ "$new_registration_compensated" -eq 1 ] &&
       [ "$prior_service_restored" -eq 1 ] &&
       [ "$restored_collection_disabled" -eq 1 ]; then
      original_registration_restored=1
    fi
  else
    original_registration_restored=1
  fi
  if ! release_lifecycle_lock; then restoration_complete=0; fi
  if [ "$restoration_complete" -eq 1 ] && [ "$original_registration_restored" -eq 1 ]; then
    /bin/rm -rf "$WORK"
  else
    echo 'Runtime Raiders rollback was incomplete; do not retry until recovery is reviewed.' >&2
    [ ! -e "$WORK" ] || echo "Runtime Raiders recovery material preserved at: $WORK" >&2
  fi
  exit "$rollback_status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$existing_form" != fresh ]; then
  existing_status_file="$WORK/existing-status.json"
  if ! "$SHIM" status --json > "$existing_status_file"; then
    echo 'Runtime Raiders requires collection to be conclusively disabled before reinstall.' >&2
    exit 1
  fi
  if [ "$has_recovery_journal" -eq 1 ]; then
    existing_status_valid=0
    if installation_status_is_ready "$existing_status_file" \
      "$existing_bundle_version" false; then existing_status_valid=1; fi
  else
    existing_status_valid=0
    if collection_is_conclusively_disabled "$existing_status_file"; then existing_status_valid=1; fi
  fi
  if [ "$existing_status_valid" -ne 1 ]; then
    echo 'Runtime Raiders requires collection to be conclusively disabled before reinstall.' >&2
    exit 1
  fi
fi

ARCHIVE="$WORK/runtime-raiders-agent.zip"
if [ -n "$LOCAL_ARCHIVE" ]; then
  case "$LOCAL_ARCHIVE" in /*) ;; *) echo 'Runtime Raiders local archive is unsafe.' >&2; exit 1;; esac
  local_archive_mode="$(/usr/bin/stat -f '%Lp' "$LOCAL_ARCHIVE" 2>/dev/null || true)"
  case "$local_archive_mode" in *[!0-7]*|'') local_archive_mode='' ;; esac
  [ -f "$LOCAL_ARCHIVE" ] && [ ! -L "$LOCAL_ARCHIVE" ] &&
    [ "$(/usr/bin/stat -f '%u' "$LOCAL_ARCHIVE")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f '%l' "$LOCAL_ARCHIVE")" = 1 ] &&
    [ "$(/usr/bin/stat -f '%z' "$LOCAL_ARCHIVE")" -le 8388608 ] &&
    [ -n "$local_archive_mode" ] &&
    [ $((0$local_archive_mode & 022)) -eq 0 ] || {
    echo 'Runtime Raiders local archive is unsafe.' >&2
    exit 1
  }
  /bin/cp "$LOCAL_ARCHIVE" "$ARCHIVE"
else
  download_status="$(/usr/bin/curl --fail --silent --show-error --proto '=https' --proto-redir '=https' \
    --max-redirs 0 --connect-timeout 10 --max-time 120 --max-filesize 8388608 --output "$ARCHIVE" \
    --write-out '%{http_code}' "$ARCHIVE_URL")" || {
    echo 'Runtime Raiders download failed.' >&2
    exit 1
  }
  [ "$download_status" = 200 ] && [ -f "$ARCHIVE" ] && [ ! -L "$ARCHIVE" ] || {
    echo 'Runtime Raiders download was invalid.' >&2
    exit 1
  }
fi
actual_archive_sha256="$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk 'NR == 1 { print $1 }')"
[ "$actual_archive_sha256" = "$ARCHIVE_SHA256" ] || {
  if [ -n "$LOCAL_ARCHIVE" ]; then
    echo 'Runtime Raiders local archive does not match this installer.' >&2
  else
    echo 'Runtime Raiders download was invalid.' >&2
  fi
  exit 1
}

UNPACKED="$WORK/unpacked"
/bin/mkdir "$UNPACKED"
/usr/bin/ditto -x -k "$ARCHIVE" "$UNPACKED"
CANDIDATE_APP="$UNPACKED/Runtime Raiders.app"
CANDIDATE_INFO="$CANDIDATE_APP/Contents/Info.plist"
CANDIDATE_AGENT="$CANDIDATE_APP/Contents/MacOS/runtime-raiders-agent"
CANDIDATE_ICON="$CANDIDATE_APP/Contents/Resources/RuntimeRaiders.icns"
CANDIDATE_MANAGED_PLIST="$CANDIDATE_APP/Contents/Library/LaunchAgents/$MANAGED_PLIST_NAME"
[ "$(/usr/bin/find "$UNPACKED" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 1 ] &&
  [ -d "$CANDIDATE_APP" ] && [ ! -L "$CANDIDATE_APP" ] &&
  [ -z "$(/usr/bin/find "$UNPACKED" -name __MACOSX -print -quit)" ] &&
  [ -z "$(/usr/bin/find "$UNPACKED" -type l -print -quit)" ] &&
  [ -f "$CANDIDATE_INFO" ] && [ ! -L "$CANDIDATE_INFO" ] &&
  [ -f "$CANDIDATE_AGENT" ] && [ ! -L "$CANDIDATE_AGENT" ] && [ -x "$CANDIDATE_AGENT" ] &&
  [ "$(/usr/bin/stat -f %u "$CANDIDATE_AGENT")" = "$OWNER" ] &&
  [ "$(/usr/bin/stat -f %l "$CANDIDATE_AGENT")" = 1 ] &&
  [ -f "$CANDIDATE_MANAGED_PLIST" ] && [ ! -L "$CANDIDATE_MANAGED_PLIST" ] || {
  echo 'Runtime Raiders archive shape or executable is invalid.' >&2
  exit 1
}
candidate_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$CANDIDATE_INFO")" &&
  candidate_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$CANDIDATE_INFO")" &&
  candidate_bundle_version="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$CANDIDATE_INFO")" &&
  candidate_executable="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CANDIDATE_INFO")" &&
  candidate_name="$(/usr/bin/plutil -extract CFBundleName raw -o - "$CANDIDATE_INFO")" &&
  candidate_display_name="$(/usr/bin/plutil -extract CFBundleDisplayName raw -o - "$CANDIDATE_INFO")" &&
  candidate_icon_file="$(/usr/bin/plutil -extract CFBundleIconFile raw -o - "$CANDIDATE_INFO")" || {
    echo 'Runtime Raiders app metadata is invalid.' >&2
    exit 1
  }
[ "$candidate_bundle_id" = "$APP_BUNDLE_ID" ] &&
  [ "$candidate_version" = "$COMPANION_VERSION" ] &&
  [ "$candidate_bundle_version" = "$COMPANION_VERSION" ] &&
  [ "$candidate_executable" = runtime-raiders-agent ] &&
  [ "$candidate_name" = 'Runtime Raiders' ] &&
  [ "$candidate_display_name" = 'Runtime Raiders' ] &&
  [ "$candidate_icon_file" = RuntimeRaiders ] &&
  [ -f "$CANDIDATE_ICON" ] && [ ! -L "$CANDIDATE_ICON" ] && [ -s "$CANDIDATE_ICON" ] || {
  echo 'Runtime Raiders app identity is invalid.' >&2
  exit 1
}
candidate_managed_label="$(/usr/bin/plutil -extract Label raw -o - "$CANDIDATE_MANAGED_PLIST")" &&
  candidate_bundle_program="$(/usr/bin/plutil -extract BundleProgram raw -o - "$CANDIDATE_MANAGED_PLIST")" &&
  candidate_program_arguments="$(/usr/bin/plutil -extract ProgramArguments json -o - "$CANDIDATE_MANAGED_PLIST")" &&
  candidate_run_at_load="$(/usr/bin/plutil -extract RunAtLoad raw -expect bool -o - "$CANDIDATE_MANAGED_PLIST")" &&
  candidate_keep_alive="$(/usr/bin/plutil -extract KeepAlive raw -expect bool -o - "$CANDIDATE_MANAGED_PLIST")" &&
  candidate_process_type="$(/usr/bin/plutil -extract ProcessType raw -o - "$CANDIDATE_MANAGED_PLIST")" || {
    echo 'Runtime Raiders managed agent metadata is invalid.' >&2
    exit 1
  }
plist_has_exact_keys "$CANDIDATE_MANAGED_PLIST" 6 \
    Label BundleProgram ProgramArguments RunAtLoad KeepAlive ProcessType &&
  [ "$candidate_managed_label" = "$MANAGED_LABEL" ] &&
  [ "$candidate_bundle_program" = Contents/MacOS/runtime-raiders-agent ] &&
  [ "$candidate_program_arguments" = '["runtime-raiders-agent","daemon"]' ] &&
  [ "$candidate_run_at_load" = true ] &&
  [ "$candidate_keep_alive" = true ] &&
  [ "$candidate_process_type" = Background ] || {
  echo 'Runtime Raiders managed agent identity is invalid.' >&2
  exit 1
}
/usr/bin/codesign --verify --deep --strict --verbose=2 "$CANDIDATE_APP"
/usr/bin/codesign --verify --strict "-R=$APP_REQUIREMENT" "$CANDIDATE_APP"
/usr/sbin/spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"
CANDIDATE_ICONSET="$WORK/candidate-icon.iconset"
/usr/bin/iconutil -c iconset "$CANDIDATE_ICON" -o "$CANDIDATE_ICONSET" >/dev/null 2>&1 &&
  [ -f "$CANDIDATE_ICONSET/icon_512x512@2x.png" ] &&
  [ ! -L "$CANDIDATE_ICONSET/icon_512x512@2x.png" ] &&
  [ -s "$CANDIDATE_ICONSET/icon_512x512@2x.png" ] || {
  echo 'Runtime Raiders icon resource is invalid.' >&2
  exit 1
}

if ! acquire_lifecycle_lock "$CANDIDATE_AGENT"; then
  echo 'Runtime Raiders could not acquire the lifecycle lock.' >&2
  exit 1
fi

case "$existing_form" in
  fresh)
    [ ! -e "$APP" ] && [ ! -e "$LEGACY_PLIST" ] && [ ! -e "$SHIM" ] &&
      [ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ] || reject_existing_layout;;
  legacy)
    [ -f "$APP/Contents/Info.plist" ] && [ ! -L "$APP/Contents/Info.plist" ] &&
      [ -f "$AGENT" ] && [ ! -L "$AGENT" ] && [ -x "$AGENT" ] &&
      [ -f "$LEGACY_PLIST" ] && [ ! -L "$LEGACY_PLIST" ] &&
      [ -f "$SHIM" ] && [ ! -L "$SHIM" ] && valid_legacy_plist "$LEGACY_PLIST" ||
      reject_existing_layout;;
  managed)
    [ -f "$APP/Contents/Info.plist" ] && [ ! -L "$APP/Contents/Info.plist" ] &&
      [ -f "$AGENT" ] && [ ! -L "$AGENT" ] && [ -x "$AGENT" ] &&
      [ ! -e "$LEGACY_PLIST" ] && [ -f "$SHIM" ] && [ ! -L "$SHIM" ] ||
      reject_existing_layout
    locked_managed_status="$("$AGENT" __runtime-raiders-managed-agent status)" ||
      reject_existing_layout
    if [ "$has_recovery_journal" -eq 1 ]; then
      [ "$locked_managed_status" = not-registered ] || reject_existing_layout
    else
      [ "$locked_managed_status" = enabled ] || reject_existing_layout
    fi;;
esac

if [ "$has_enrollment" -eq 1 ]; then
  validate_enrollment || reject_existing_layout
elif [ -e "$ENROLLMENT" ] || [ -L "$ENROLLMENT" ]; then
  reject_existing_layout
fi
if [ "$has_recovery_journal" -eq 1 ]; then
  validate_recovery_journal || reject_existing_layout
elif [ -e "$RECOVERY_JOURNAL" ] || [ -L "$RECOVERY_JOURNAL" ]; then
  reject_existing_layout
fi
if [ "$existing_form" != fresh ]; then
  locked_status_file="$WORK/locked-existing-status.json"
  "$SHIM" status --json > "$locked_status_file" || reject_existing_layout
  if [ "$has_recovery_journal" -eq 1 ]; then
    installation_status_is_ready "$locked_status_file" \
      "$existing_bundle_version" false || reject_existing_layout
  else
    collection_is_conclusively_disabled "$locked_status_file" || reject_existing_layout
  fi
fi

prove_lifecycle_lock || {
  echo 'Runtime Raiders lost the lifecycle lock.' >&2
  exit 1
}

if [ "$existing_form" = legacy ]; then
  legacy_registration_state="$(legacy_job_registration_state)" || {
    echo 'Runtime Raiders could not inspect the existing legacy background agent.' >&2
    exit 1
  }
  legacy_initial_registration_known=1
  if [ "$legacy_registration_state" = registered ]; then legacy_was_registered=1; fi
fi

if [ -n "$LOCAL_ARCHIVE" ] && [ "$has_enrollment" -eq 0 ]; then
  echo 'Runtime Raiders local canary requires valid existing enrollment.' >&2
  exit 1
fi

if [ "$fresh_enrollment" -eq 1 ]; then
  [ -r /dev/tty ] && [ -w /dev/tty ] || usage
  tty_state="$(/bin/stty -g < /dev/tty)" || usage
  printf '%s\n' \
    'Get a one-time enrollment code before continuing:' \
    '  New Raider: https://raiders.redlattice.com/register' \
    '  Existing Raider: https://raiders.redlattice.com/character' \
    'This is not your Raider Key. The code expires after 10 minutes.' >&2
  printf 'Runtime Raiders one-time enrollment code: ' >&2
  /bin/stty -echo < /dev/tty
  tty_changed=1
  enrollment_code=''
  IFS= read -r enrollment_code < /dev/tty || usage
  restore_tty
  printf '\n' >&2
  case "$enrollment_code" in *[!A-Za-z0-9_-]*|'') usage;; esac
  [ "${#enrollment_code}" -eq 43 ] || usage
  device_id="$(/usr/bin/uuidgen)"
  response="$WORK/enrollment-response.json"
  enrollment_status="$({
    printf '{"code":"%s","device_id":"%s","companion_version":"%s"}' \
      "$enrollment_code" "$device_id" "$COMPANION_VERSION"
  } | /usr/bin/curl --fail --silent --show-error --proto '=https' --proto-redir '=https' \
    --max-redirs 0 --connect-timeout 10 --max-time 30 --max-filesize 65536 \
    -X POST -H 'Content-Type: application/json' --data-binary @- \
    --write-out '%{http_code}' --output "$response" "$ENROLL_URL")" || {
    echo 'Runtime Raiders enrollment failed.' >&2
    exit 1
  }
  enrollment_code=''
  [ "$enrollment_status" = 201 ] || exit 1
  validate_enrollment_response "$response" || {
    echo 'Runtime Raiders enrollment response was invalid.' >&2
    exit 1
  }
  device_token="$(/usr/bin/plutil -extract device_token raw -o - "$response")" &&
    dedupe_secret="$(/usr/bin/plutil -extract dedupe_secret raw -o - "$response")" &&
    server_url="$(/usr/bin/plutil -extract server_url raw -o - "$response")" &&
    cutover_at="$(/usr/bin/plutil -extract cutover_at raw -o - "$response")" &&
    enabled_surfaces="$(/usr/bin/plutil -extract enabled_surfaces json -o - "$response")" || exit 1
  [ "$server_url" = "$ORIGIN" ] || exit 1
  case "$device_token" in *[!A-Za-z0-9_-]*|'') exit 1;; esac
  case "$dedupe_secret" in *[!0123456789abcdef]*|'') exit 1;; esac
  case "$cutover_at" in *[!0123456789]*|'') exit 1;; esac
  [ "${#device_token}" -eq 43 ] && [ "${#dedupe_secret}" -eq 64 ] &&
    [ "$cutover_at" -le 9007199254740991 ] || exit 1
  case "$enabled_surfaces" in
    '["codex_desktop"]'|'["codex_cli"]'|'["codex_desktop","codex_cli"]'|'["codex_cli","codex_desktop"]') ;;
    *) exit 1;;
  esac
  valid_uuid "$device_id" || exit 1
  staged_enrollment="$(/usr/bin/mktemp "$STATE/.enrollment.XXXXXX")"
  printf '{"version":1,"device_id":"%s","device_token":"%s","dedupe_secret":"%s","server_url":"%s","cutover_at":%s,"enabled_surfaces":%s}\n' \
    "$device_id" "$device_token" "$dedupe_secret" "$server_url" "$cutover_at" "$enabled_surfaces" > "$staged_enrollment"
  /bin/chmod 600 "$staged_enrollment"
  validate_enrollment_contents "$staged_enrollment" || exit 1
  prove_lifecycle_lock || exit 1
  /bin/mv "$staged_enrollment" "$ENROLLMENT"
fi

STAGED_SHIM="$WORK/staged.shim"
cat > "$STAGED_SHIM" <<'EOF'
#!/bin/sh
set -eu
exec "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent" "$@"
EOF
/bin/chmod 700 "$STAGED_SHIM"
STAGED_COMMAND=''
if [ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ]; then
  STAGED_COMMAND="$WORK/staged.command"
  /bin/ln -s "$SHIM" "$STAGED_COMMAND"
fi

transaction_active=1
prove_lifecycle_lock || exit 1
case "$existing_form" in
  legacy)
    if [ "$legacy_was_registered" -eq 1 ]; then
      legacy_stop_attempted=1
      /bin/launchctl bootout "gui/$OWNER/$LEGACY_LABEL" 2>/dev/null || {
        echo 'Runtime Raiders could not stop the existing legacy background agent.' >&2
        exit 1
      }
      stopped_legacy_state="$(legacy_job_registration_state)" || {
        echo 'Runtime Raiders could not verify the legacy background agent stopped.' >&2
        exit 1
      }
      [ "$stopped_legacy_state" = absent ] || {
        echo 'Runtime Raiders could not verify the legacy background agent stopped.' >&2
        exit 1
      }
    fi
    ;;
  managed)
    if [ "$has_recovery_journal" -eq 0 ]; then
      old_managed_unregister_attempted=1
      if old_managed_result="$("$AGENT" __runtime-raiders-managed-agent unregister)"; then
        [ "$old_managed_result" = not-registered ] || {
          echo 'Runtime Raiders could not unregister the existing managed agent.' >&2
          exit 1
        }
      else
        echo 'Runtime Raiders could not unregister the existing managed agent.' >&2
        exit 1
      fi
    fi
    ;;
esac

prove_lifecycle_lock || exit 1
if [ -e "$APP" ]; then /bin/mv "$APP" "$WORK/old.app"; fi
if [ -e "$LEGACY_PLIST" ]; then /bin/mv "$LEGACY_PLIST" "$WORK/old.plist"; fi
if [ -e "$SHIM" ]; then /bin/mv "$SHIM" "$WORK/old.shim"; fi

/bin/mv "$CANDIDATE_APP" "$APP"
/bin/mv "$STAGED_SHIM" "$SHIM"

if [ -n "$STAGED_COMMAND" ]; then
  /bin/mv "$STAGED_COMMAND" "$COMMAND"
fi

installed_status_file="$WORK/installed-status.json"
if [ "$has_recovery_journal" -eq 1 ]; then
  if ! wait_for_installation_status "$COMMAND" "$installed_status_file" \
    "$COMPANION_VERSION" false; then
    print_installation_status_diagnostic "$installed_status_file" "$COMPANION_VERSION" >&2
    echo 'Runtime Raiders could not prove its stopped recovery companion was healthy with collection disabled.' >&2
    exit 1
  fi
else
  new_managed_register_attempted=1
  if managed_result="$("$AGENT" __runtime-raiders-managed-agent register)"; then
    [ "$managed_result" = enabled ] || {
      echo 'Runtime Raiders could not register its managed background agent.' >&2
      exit 1
    }
  else
    echo 'Runtime Raiders could not register its managed background agent.' >&2
    exit 1
  fi
  installed_managed_status="$("$AGENT" __runtime-raiders-managed-agent status)" || {
    echo 'Runtime Raiders could not verify its managed background agent.' >&2
    exit 1
  }
  [ "$installed_managed_status" = enabled ] || {
    echo 'Runtime Raiders could not verify its managed background agent.' >&2
    exit 1
  }
  if ! wait_for_installation_status "$COMMAND" "$installed_status_file" \
    "$COMPANION_VERSION" true; then
    print_installation_status_diagnostic "$installed_status_file" "$COMPANION_VERSION" >&2
    echo 'Runtime Raiders could not prove its registered agent was healthy with collection disabled.' >&2
    exit 1
  fi
fi

prove_lifecycle_lock || exit 1
if ! release_lifecycle_lock; then
  echo 'Runtime Raiders could not release the lifecycle lock safely.' >&2
  exit 1
fi
transaction_committed=1
trap - EXIT HUP INT TERM
/bin/rm -rf "$WORK"
if [ "$has_recovery_journal" -eq 1 ]; then
  printf '%s\n' \
    'Runtime Raiders is installed.' \
    'Collection is OFF.' \
    'Run `raiders status` to check the setup.' \
    'Run `raiders re-enroll` to resume recovery.'
else
  printf '%s\n' \
    'Runtime Raiders is installed.' \
    'Collection is OFF.' \
    'Run `raiders status` to check the setup.' \
    'Run `raiders on` when you want to join the game.'
fi
