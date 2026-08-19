#!/bin/sh
set -eu

COMPANION_VERSION='__RUNTIME_RAIDERS_COMPANION_VERSION__'
TEAM_ID='__RUNTIME_RAIDERS_TEAM_ID__'
ARCHIVE_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'

ENROLL_URL='https://raiders.redlattice.com/api/raiders/enroll'
ORIGIN='https://raiders.redlattice.com'
LABEL='com.redlattice.runtime-raiders-agent'
AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'

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
APP="$SUPPORT/Runtime Raiders Agent.app"
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
  "$APP" "$LAUNCH_AGENTS" "$PLIST" "$SHIM" "$HOME/.local" "$COMMAND_DIRECTORY" \
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

validate_enrollment() {
  [ -f "$ENROLLMENT" ] && [ ! -L "$ENROLLMENT" ] &&
    [ "$(/usr/bin/stat -f %u "$ENROLLMENT")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f %Lp "$ENROLLMENT")" = 600 ] || return 1
  enrollment_version="$(/usr/bin/plutil -extract version raw -o - "$ENROLLMENT")" &&
    enrollment_device_id="$(/usr/bin/plutil -extract device_id raw -o - "$ENROLLMENT")" &&
    enrollment_token="$(/usr/bin/plutil -extract device_token raw -o - "$ENROLLMENT")" &&
    enrollment_secret="$(/usr/bin/plutil -extract dedupe_secret raw -o - "$ENROLLMENT")" &&
    enrollment_server="$(/usr/bin/plutil -extract server_url raw -o - "$ENROLLMENT")" &&
    enrollment_cutover="$(/usr/bin/plutil -extract cutover_at raw -o - "$ENROLLMENT")" &&
    enrollment_surfaces="$(/usr/bin/plutil -extract enabled_surfaces json -o - "$ENROLLMENT")" || return 1
  [ "$enrollment_version" = 1 ] && [ "$enrollment_server" = "$ORIGIN" ] &&
    [ "$enrollment_surfaces" = '["codex_desktop","codex_cli"]' ] || return 1
  case "$enrollment_device_id" in *[!A-Fa-f0-9-]*|'') return 1;; esac
  case "$enrollment_token" in *[!A-Za-z0-9_-]*|'') return 1;; esac
  case "$enrollment_secret" in *[!0123456789abcdef]*|'') return 1;; esac
  case "$enrollment_cutover" in *[!0123456789]*|'') return 1;; esac
  [ "${#enrollment_token}" -eq 43 ] && [ "${#enrollment_secret}" -eq 64 ]
}

has_enrollment=0
if [ -e "$ENROLLMENT" ] || [ -L "$ENROLLMENT" ]; then
  refuse_symlink "$ENROLLMENT"
  validate_enrollment || {
    echo 'Runtime Raiders refuses invalid existing enrollment.' >&2
    exit 1
  }
  has_enrollment=1
fi

WORK="$(/usr/bin/mktemp -d "$SUPPORT/.runtime-raiders-install.XXXXXX")"
PLIST_BACKUP_DIRECTORY=''
transaction_active=0
transaction_committed=0
had_app=0
had_plist=0
had_shim=0
command_created=0
tty_changed=0
tty_state=''

restore_tty() {
  if [ "$tty_changed" -eq 1 ]; then
    /usr/bin/stty "$tty_state" < /dev/tty 2>/dev/null || true
    tty_changed=0
  fi
}

rollback() {
  rollback_status=$?
  trap - EXIT HUP INT TERM
  restore_tty
  if [ "$transaction_active" -eq 1 ] && [ "$transaction_committed" -eq 0 ]; then
    /bin/launchctl bootout "gui/$OWNER/$LABEL" 2>/dev/null || true
    /bin/rm -rf "$APP"
    /bin/rm -f "$PLIST" "$SHIM"
    if [ "$had_app" -eq 1 ] && [ -e "$WORK/old.app" ]; then
      /bin/mv "$WORK/old.app" "$APP" || true
    fi
    if [ "$had_plist" -eq 1 ] && [ -n "$PLIST_BACKUP_DIRECTORY" ] &&
       [ -e "$PLIST_BACKUP_DIRECTORY/old.plist" ]; then
      /bin/mv "$PLIST_BACKUP_DIRECTORY/old.plist" "$PLIST" || true
    fi
    if [ "$had_shim" -eq 1 ] && [ -e "$WORK/old.shim" ]; then
      /bin/mv "$WORK/old.shim" "$SHIM" || true
    fi
    if [ "$command_created" -eq 1 ]; then /bin/rm -f "$COMMAND"; fi
    if [ "$reinstall" -eq 1 ] && [ -e "$PLIST" ]; then
      /bin/launchctl bootstrap "gui/$OWNER" "$PLIST" >/dev/null 2>&1 || true
    fi
  fi
  /bin/rm -rf "$WORK"
  if [ -n "$PLIST_BACKUP_DIRECTORY" ]; then /bin/rm -rf "$PLIST_BACKUP_DIRECTORY"; fi
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
CANDIDATE_APP="$UNPACKED/Runtime Raiders Agent.app"
CANDIDATE_INFO="$CANDIDATE_APP/Contents/Info.plist"
CANDIDATE_AGENT="$CANDIDATE_APP/Contents/MacOS/runtime-raiders-agent"
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
  candidate_executable="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CANDIDATE_INFO")" || {
    echo 'Runtime Raiders app metadata is invalid.' >&2
    exit 1
  }
[ "$candidate_bundle_id" = "$LABEL" ] &&
  [ "$candidate_version" = "$COMPANION_VERSION" ] &&
  [ "$candidate_executable" = runtime-raiders-agent ] || {
  echo 'Runtime Raiders app identity is invalid.' >&2
  exit 1
}
/usr/bin/codesign --verify --deep --strict --verbose=2 "$CANDIDATE_APP"
/usr/bin/codesign --verify --strict -R "$AGENT_REQUIREMENT" "$CANDIDATE_APP"
/usr/sbin/spctl --assess --type execute --verbose=2 "$CANDIDATE_APP"

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
  device_token="$(/usr/bin/plutil -extract device_token raw -o - "$response")" &&
    dedupe_secret="$(/usr/bin/plutil -extract dedupe_secret raw -o - "$response")" &&
    server_url="$(/usr/bin/plutil -extract server_url raw -o - "$response")" &&
    cutover_at="$(/usr/bin/plutil -extract cutover_at raw -o - "$response")" &&
    enabled_surfaces="$(/usr/bin/plutil -extract enabled_surfaces json -o - "$response")" || exit 1
  [ "$server_url" = "$ORIGIN" ] && [ "$enabled_surfaces" = '["codex_desktop","codex_cli"]' ] &&
    [ "${#device_token}" -eq 43 ] && [ "${#dedupe_secret}" -eq 64 ] || exit 1
  staged_enrollment="$(/usr/bin/mktemp "$STATE/.enrollment.XXXXXX")"
  printf '{"version":1,"device_id":"%s","device_token":"%s","dedupe_secret":"%s","server_url":"%s","cutover_at":%s,"enabled_surfaces":%s}\n' \
    "$device_id" "$device_token" "$dedupe_secret" "$server_url" "$cutover_at" "$enabled_surfaces" > "$staged_enrollment"
  /bin/chmod 600 "$staged_enrollment"
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
exec "$HOME/Library/Application Support/Runtime Raiders/Runtime Raiders Agent.app/Contents/MacOS/runtime-raiders-agent" "$@"
EOF
/bin/chmod 700 "$STAGED_SHIM"

PLIST_BACKUP_DIRECTORY="$(/usr/bin/mktemp -d "$LAUNCH_AGENTS/.runtime-raiders-backup.XXXXXX")"
transaction_active=1
/bin/launchctl bootout "gui/$OWNER/$LABEL" 2>/dev/null || true

if [ -e "$APP" ]; then /bin/mv "$APP" "$WORK/old.app"; had_app=1; fi
if [ -e "$PLIST" ]; then /bin/mv "$PLIST" "$PLIST_BACKUP_DIRECTORY/old.plist"; had_plist=1; fi
if [ -e "$SHIM" ]; then /bin/mv "$SHIM" "$WORK/old.shim"; had_shim=1; fi

/bin/mv "$CANDIDATE_APP" "$APP"
/bin/mv "$STAGED_PLIST" "$PLIST"
/bin/mv "$STAGED_SHIM" "$SHIM"

if [ ! -e "$COMMAND" ] && [ ! -L "$COMMAND" ]; then
  staged_command="$COMMAND_DIRECTORY/.raiders.$$"
  /bin/ln -s "$SHIM" "$staged_command"
  /bin/mv "$staged_command" "$COMMAND"
  command_created=1
fi

/bin/launchctl bootstrap "gui/$OWNER" "$PLIST"
"$COMMAND" status >/dev/null

transaction_committed=1
trap - EXIT HUP INT TERM
/bin/rm -rf "$WORK" "$PLIST_BACKUP_DIRECTORY"
echo "Runtime Raiders installed. Run 'raiders status' to check it."
