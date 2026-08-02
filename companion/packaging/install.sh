#!/bin/sh
set -eu

ARTIFACT_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip'
CHECKSUM_URL='https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip.sha256'
ENROLL_URL='https://raiders.redlattice.com/api/raiders/enroll'
VERSION='0.1.0'
LABEL='com.redlattice.runtime-raiders-agent'
MARKER='export PATH="$HOME/.local/bin:$PATH" # runtime-raiders-path'

usage() {
  echo "usage: install.sh --code <one-time-code>" >&2
  exit 64
}
code=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --code) [ "$#" -ge 2 ] || usage; code="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$code" ] || usage
case "$code" in *[!A-Za-z0-9_-]*|'') usage ;; esac
code_length="$(printf '%s' "$code" | wc -c | tr -d ' ')"
[ "$code_length" -eq 43 ] || usage

umask 077
SUPPORT="$HOME/Library/Application Support/Runtime Raiders"
STATE="$SUPPORT/state"
OUTBOX="$SUPPORT/outbox"
APP="$SUPPORT/Runtime Raiders Agent.app"
EXECUTABLE="$APP/Contents/MacOS/runtime-raiders-agent"
SHIM="$SUPPORT/raiders"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
COMMAND_LINK_FILE="$STATE/command-link"
mkdir -p "$STATE" "$OUTBOX" "$HOME/Library/LaunchAgents"
chmod 700 "$SUPPORT" "$STATE" "$OUTBOX" "$HOME/Library/LaunchAgents"
WORK="$(mktemp -d "$SUPPORT/.install.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT HUP INT TERM

ARCHIVE="$WORK/runtime-raiders-agent.zip"
CHECKSUM="$WORK/runtime-raiders-agent.zip.sha256"
curl -fsSL "$ARTIFACT_URL" -o "$ARCHIVE"
curl -fsSL "$CHECKSUM_URL" -o "$CHECKSUM"
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
codesign --verify --strict --verbose=2 "$CANDIDATE"

ENROLLMENT="$STATE/enrollment.json"
if [ ! -f "$ENROLLMENT" ]; then
  device_id="$(uuidgen)"
  response="$WORK/enrollment-response.json"
  request="$(printf '{"code":"%s","device_id":"%s","companion_version":"%s"}' "$code" "$device_id" "$VERSION")"
  enrollment_status="$(curl -fsSL -X POST -H 'Content-Type: application/json' --data "$request" "$ENROLL_URL" -w '%{http_code}' -o "$response")"
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
  printf '{"version":1,"device_id":"%s","device_token":"%s","dedupe_secret":"%s","server_url":"%s","cutover_at":%s,"enabled_surfaces":%s}\n' \
    "$device_id" "$device_token" "$dedupe_secret" "$server_url" "$cutover_at" "$enabled_surfaces" > "$WORK/enrollment.json"
  chmod 600 "$WORK/enrollment.json"
fi

rm -rf "$APP"
mv "$CANDIDATE" "$APP"
chmod 700 "$EXECUTABLE"
if [ ! -f "$ENROLLMENT" ]; then
  mv "$WORK/enrollment.json" "$ENROLLMENT"
  chmod 600 "$ENROLLMENT"
fi
cat > "$PLIST" <<EOF
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
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"

command_dir=''
old_ifs="$IFS"
IFS=:
for candidate in $PATH; do
  [ -n "$candidate" ] && [ -d "$candidate" ] && [ -w "$candidate" ] || continue
  command_dir="$candidate"
  break
done
IFS="$old_ifs"
if [ -z "$command_dir" ]; then
  command_dir="$HOME/.local/bin"
  mkdir -p "$command_dir"
  chmod 700 "$HOME/.local" "$command_dir"
  profile="$HOME/.zprofile"
  touch "$profile"
  grep -F -x "$MARKER" "$profile" >/dev/null 2>&1 || {
    printf '%s\n' "$MARKER" >> "$profile"
    echo "Added Runtime Raiders to PATH in $profile; open a new shell to use raiders."
  }
fi
command_path="$command_dir/raiders"
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$SHIM" ] || {
    echo "refusing to replace existing $command_path" >&2
    exit 1
  }
fi
cat > "$SHIM" <<EOF
#!/bin/sh
set -eu
SUPPORT='$SUPPORT'
PLIST='$PLIST'
SHIM='$SHIM'
COMMAND_LINK_FILE='$COMMAND_LINK_FILE'
MARKER='$MARKER'
LABEL='$LABEL'
binary='$EXECUTABLE'
if [ "\$#" -eq 0 ] || [ "\$1" != uninstall ]; then
  exec "\$binary" "\$@"
fi
if "\$binary" uninstall; then
  :
elif [ ! -S "\$SUPPORT/agent.sock" ] && ! launchctl print "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1; then
  :
else
  echo "Runtime Raiders daemon did not safely stop; refusing cleanup" >&2
  exit 1
fi
launchctl bootout "gui/\$(id -u)" "\$PLIST" >/dev/null 2>&1 || true
if [ -f "\$COMMAND_LINK_FILE" ]; then
  command_path="\$(cat "\$COMMAND_LINK_FILE")"
  if [ -L "\$command_path" ] && [ "\$(readlink "\$command_path")" = "\$SHIM" ]; then
    rm -f "\$command_path"
  fi
fi
profile="\$HOME/.zprofile"
if [ -f "\$profile" ]; then
  temporary="\$profile.runtime-raiders-tmp"
  awk -v marker="\$MARKER" '\$0 != marker { print }' "\$profile" > "\$temporary"
  mv "\$temporary" "\$profile"
fi
rm -f "\$PLIST"
rm -rf "\$SUPPORT"
EOF
chmod 700 "$SHIM"
printf '%s\n' "$command_path" > "$COMMAND_LINK_FILE"
chmod 600 "$COMMAND_LINK_FILE"
ln -sfn "$SHIM" "$command_path"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Runtime Raiders installed. Run 'raiders status' to check it."
