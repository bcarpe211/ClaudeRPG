#!/bin/sh
set -eu

COMPANION_VERSION='__RUNTIME_RAIDERS_COMPANION_VERSION__'
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'
ARCHIVE_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'

ENROLL_URL='https://raiders.redlattice.com/api/raiders/enroll'
ORIGIN='https://raiders.redlattice.com'
LABEL='com.redlattice.runtime-raiders-agent'
APP_BUNDLE_ID='com.redlattice.runtime-raiders'
AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

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
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
COMMAND_DIRECTORY="$HOME/.local/bin"
COMMAND="$COMMAND_DIRECTORY/raiders"
ENROLLMENT="$STATE/enrollment.json"
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
  "$APP" "$LEGACY_APP" "$LAUNCH_AGENTS" "$PLIST" "$SHIM" "$HOME/.local" "$COMMAND_DIRECTORY" \
  "$RELEASES" "$INSTALLATION" "$LAUNCHER"; do
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
for owned_file in "$PLIST" "$SHIM"; do
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

existing_count=0
[ ! -e "$APP" ] || existing_count=$((existing_count + 1))
[ ! -e "$PLIST" ] || existing_count=$((existing_count + 1))
[ ! -e "$SHIM" ] || existing_count=$((existing_count + 1))
case "$existing_count" in
  0) reinstall=0;;
  3) reinstall=1;;
  *) echo 'Runtime Raiders refuses a partial existing installation.' >&2; exit 1;;
esac

/bin/mkdir -p "$STATE" "$OUTBOX" "$LAUNCH_AGENTS" "$COMMAND_DIRECTORY"
[ -e "$SUPPORT" ] || exit 1

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
    validate_enrollment_contents "$ENROLLMENT"
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

has_enrollment=0
if [ -e "$ENROLLMENT" ] || [ -L "$ENROLLMENT" ]; then
  refuse_symlink "$ENROLLMENT"
  [ -f "$ENROLLMENT" ] &&
    [ "$(/usr/bin/stat -f %u "$ENROLLMENT")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f %Lp "$ENROLLMENT")" = 600 ] || {
    echo 'Runtime Raiders refuses unsafe existing enrollment.' >&2
    exit 1
  }
  if validate_enrollment; then has_enrollment=1; fi
fi

WORK="$(/usr/bin/mktemp -d "$SUPPORT/.runtime-raiders-install.XXXXXX")"
PLIST_BACKUP_DIRECTORY=''
transaction_active=0
transaction_committed=0
original_app=0
original_plist=0
original_shim=0
original_command=0
[ ! -e "$APP" ] || original_app=1
[ ! -e "$PLIST" ] || original_plist=1
[ ! -e "$SHIM" ] || original_shim=1
[ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ] || original_command=1
tty_changed=0
tty_state=''

restore_tty() {
  if [ "$tty_changed" -eq 1 ]; then
    /usr/bin/stty "$tty_state" < /dev/tty 2>/dev/null || true
    tty_changed=0
  fi
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
  if [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ]; then
    /bin/launchctl bootout "gui/$OWNER/$LABEL" 2>/dev/null || true
    if ! restore_target "$APP" "$WORK/old.app" "$WORK/failed.app" "$original_app"; then
      restoration_complete=0
    fi
    if ! restore_target "$PLIST" "$PLIST_BACKUP_DIRECTORY/old.plist" \
      "$PLIST_BACKUP_DIRECTORY/failed.plist" "$original_plist"; then
      restoration_complete=0
    fi
    if ! restore_target "$SHIM" "$WORK/old.shim" "$WORK/failed.shim" "$original_shim"; then
      restoration_complete=0
    fi
    if [ "$original_command" -eq 0 ] && { [ -e "$COMMAND" ] || [ -L "$COMMAND" ]; }; then
      /bin/rm -f "$COMMAND" || restoration_complete=0
    fi
    if [ "$restoration_complete" -eq 1 ] && [ "$reinstall" -eq 1 ]; then
      if ! /bin/launchctl bootstrap "gui/$OWNER" "$PLIST" >/dev/null 2>&1; then
        restoration_complete=0
      fi
    fi
  fi
  if [ "$restoration_complete" -eq 1 ]; then
    /bin/rm -rf "$WORK"
    if [ -n "$PLIST_BACKUP_DIRECTORY" ]; then /bin/rm -rf "$PLIST_BACKUP_DIRECTORY"; fi
  else
    echo 'Runtime Raiders rollback was incomplete; do not retry until recovery is reviewed.' >&2
    [ ! -e "$WORK" ] || echo "Runtime Raiders recovery material preserved at: $WORK" >&2
    if [ -n "$PLIST_BACKUP_DIRECTORY" ] && [ -e "$PLIST_BACKUP_DIRECTORY" ]; then
      echo "Runtime Raiders recovery material preserved at: $PLIST_BACKUP_DIRECTORY" >&2
    fi
  fi
  exit "$rollback_status"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ARCHIVE="$WORK/runtime-raiders-agent.zip"
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

UNPACKED="$WORK/unpacked"
/bin/mkdir "$UNPACKED"
/usr/bin/ditto -x -k "$ARCHIVE" "$UNPACKED"
CANDIDATE_APP="$UNPACKED/Runtime Raiders.app"
CANDIDATE_INFO="$CANDIDATE_APP/Contents/Info.plist"
CANDIDATE_AGENT="$CANDIDATE_APP/Contents/MacOS/runtime-raiders-agent"
CANDIDATE_ICON="$CANDIDATE_APP/Contents/Resources/RuntimeRaiders.icns"
[ "$(/usr/bin/find "$UNPACKED" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 1 ] &&
  [ -d "$CANDIDATE_APP" ] && [ ! -L "$CANDIDATE_APP" ] &&
  [ -z "$(/usr/bin/find "$UNPACKED" -name __MACOSX -print -quit)" ] &&
  [ -z "$(/usr/bin/find "$UNPACKED" -type l -print -quit)" ] &&
  [ -f "$CANDIDATE_INFO" ] && [ ! -L "$CANDIDATE_INFO" ] &&
  [ -f "$CANDIDATE_AGENT" ] && [ ! -L "$CANDIDATE_AGENT" ] && [ -x "$CANDIDATE_AGENT" ] || {
  echo 'Runtime Raiders archive shape or executable is invalid.' >&2
  exit 1
}
candidate_bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$CANDIDATE_INFO")" &&
  candidate_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$CANDIDATE_INFO")" &&
  candidate_executable="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CANDIDATE_INFO")" &&
  candidate_name="$(/usr/bin/plutil -extract CFBundleName raw -o - "$CANDIDATE_INFO")" &&
  candidate_display_name="$(/usr/bin/plutil -extract CFBundleDisplayName raw -o - "$CANDIDATE_INFO")" &&
  candidate_icon_file="$(/usr/bin/plutil -extract CFBundleIconFile raw -o - "$CANDIDATE_INFO")" || {
    echo 'Runtime Raiders app metadata is invalid.' >&2
    exit 1
  }
[ "$candidate_bundle_id" = "$APP_BUNDLE_ID" ] &&
  [ "$candidate_version" = "$COMPANION_VERSION" ] &&
  [ "$candidate_executable" = runtime-raiders-agent ] &&
  [ "$candidate_name" = 'Runtime Raiders' ] &&
  [ "$candidate_display_name" = 'Runtime Raiders' ] &&
  [ "$candidate_icon_file" = RuntimeRaiders ] &&
  [ -f "$CANDIDATE_ICON" ] && [ ! -L "$CANDIDATE_ICON" ] && [ -s "$CANDIDATE_ICON" ] || {
  echo 'Runtime Raiders app identity is invalid.' >&2
  exit 1
}
/usr/bin/codesign --verify --deep --strict --verbose=2 "$CANDIDATE_APP"
/usr/bin/codesign --verify --strict "-R=$AGENT_REQUIREMENT" "$CANDIDATE_APP"
/usr/sbin/spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"
CANDIDATE_ICONSET="$WORK/candidate-icon.iconset"
/usr/bin/iconutil -c iconset "$CANDIDATE_ICON" -o "$CANDIDATE_ICONSET" >/dev/null 2>&1 &&
  [ -f "$CANDIDATE_ICONSET/icon_512x512@2x.png" ] &&
  [ ! -L "$CANDIDATE_ICONSET/icon_512x512@2x.png" ] &&
  [ -s "$CANDIDATE_ICONSET/icon_512x512@2x.png" ] || {
  echo 'Runtime Raiders icon resource is invalid.' >&2
  exit 1
}

if [ "$has_enrollment" -eq 0 ]; then
  [ -r /dev/tty ] && [ -w /dev/tty ] || usage
  tty_state="$(/usr/bin/stty -g < /dev/tty)" || usage
  printf 'Runtime Raiders one-time enrollment code: ' >&2
  /usr/bin/stty -echo < /dev/tty
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
  /bin/mv "$staged_enrollment" "$ENROLLMENT"
fi

STAGED_PLIST="$(/usr/bin/mktemp "$LAUNCH_AGENTS/.runtime-raiders-plist.XXXXXX")"
cat > "$STAGED_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>$LABEL</string>
  </array>
  <key>ProgramArguments</key>
  <array>
    <string>$AGENT</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
/bin/chmod 600 "$STAGED_PLIST"

STAGED_SHIM="$(/usr/bin/mktemp "$SUPPORT/.runtime-raiders-shim.XXXXXX")"
cat > "$STAGED_SHIM" <<'EOF'
#!/bin/sh
set -eu
exec "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders.app/Contents/MacOS/runtime-raiders-agent" "$@"
EOF
/bin/chmod 700 "$STAGED_SHIM"

PLIST_BACKUP_DIRECTORY="$(/usr/bin/mktemp -d "$LAUNCH_AGENTS/.runtime-raiders-backup.XXXXXX")"
transaction_active=1
/bin/launchctl bootout "gui/$OWNER/$LABEL" 2>/dev/null || true

if [ -e "$APP" ]; then /bin/mv "$APP" "$WORK/old.app"; fi
if [ -e "$PLIST" ]; then /bin/mv "$PLIST" "$PLIST_BACKUP_DIRECTORY/old.plist"; fi
if [ -e "$SHIM" ]; then /bin/mv "$SHIM" "$WORK/old.shim"; fi

/bin/mv "$CANDIDATE_APP" "$APP"
"$AGENT" __runtime-raiders-register-application || {
  echo 'Runtime Raiders could not register its background-item identity.' >&2
  exit 1
}
/bin/mv "$STAGED_PLIST" "$PLIST"
/bin/mv "$STAGED_SHIM" "$SHIM"

if [ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ]; then
  staged_command="$COMMAND_DIRECTORY/.raiders.$$"
  /bin/ln -s "$SHIM" "$staged_command"
  /bin/mv "$staged_command" "$COMMAND"
fi

/bin/launchctl bootstrap "gui/$OWNER" "$PLIST"
"$COMMAND" status >/dev/null

transaction_committed=1
trap - EXIT HUP INT TERM
/bin/rm -rf "$WORK" "$PLIST_BACKUP_DIRECTORY"
echo "Runtime Raiders installed. Run 'raiders status' to check it."
