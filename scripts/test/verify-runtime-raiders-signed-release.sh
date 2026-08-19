#!/bin/bash

set -euo pipefail

usage() {
  echo "usage: $0 /absolute/path/to/local-runtime-raiders-beta-release" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
case "$1" in http://*|https://*) echo "signed verifier refuses URLs" >&2; exit 64 ;; esac
[ -d "$1" ] && [ ! -L "$1" ] || usage

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
RELEASE_DIR="$(cd "$1" && pwd -P)"
OWNER="$(/usr/bin/id -u)"
WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/runtime-raiders-beta-verify.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$WORK" == "${TMPDIR:-/tmp}"/runtime-raiders-beta-verify.* ]]; then
    /bin/rm -rf -- "$WORK" || status=1
  else
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$(/usr/bin/stat -f '%u' "$RELEASE_DIR")" = "$OWNER" ] || {
  echo "signed verifier refuses an unowned release directory" >&2
  exit 1
}
[ "$(/usr/bin/find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 4 ] || {
  echo "signed verifier requires exactly three public files and release-summary.txt" >&2
  exit 1
}

INSTALLER="$RELEASE_DIR/install.sh"
ARCHIVE="$RELEASE_DIR/runtime-raiders-agent.zip"
VERSION_FILE="$RELEASE_DIR/version"
SUMMARY="$RELEASE_DIR/release-summary.txt"
for file in "$INSTALLER" "$ARCHIVE" "$VERSION_FILE" "$SUMMARY"; do
  [ -f "$file" ] && [ ! -L "$file" ] &&
    [ "$(/usr/bin/stat -f '%u' "$file")" = "$OWNER" ] &&
    [ "$(/usr/bin/stat -f '%l' "$file")" = 1 ] || {
    echo "signed verifier refuses an unsafe release member" >&2
    exit 1
  }
  mode="$(/usr/bin/stat -f '%Lp' "$file")"
  (( (8#$mode & 8#022) == 0 )) || {
    echo "signed verifier refuses writable release members" >&2
    exit 1
  }
done
[ -x "$INSTALLER" ] || {
  echo "signed verifier requires executable install.sh" >&2
  exit 1
}

VERSION_DOCUMENT="$(<"$VERSION_FILE")"
VERSION_PATTERN='^\{"version":"([0-9]+\.[0-9]+\.[0-9]+)"\}$'
[[ "$VERSION_DOCUMENT" =~ $VERSION_PATTERN ]] || {
  echo "version is not canonical" >&2
  exit 1
}
COMPANION_VERSION="${BASH_REMATCH[1]}"
[ "$(/usr/bin/wc -l < "$VERSION_FILE" | /usr/bin/tr -d ' ')" -eq 1 ] &&
  [ "$(/usr/bin/wc -c < "$VERSION_FILE" | /usr/bin/tr -d ' ')" -eq $((${#VERSION_DOCUMENT} + 1)) ] || {
  echo "version is not canonical" >&2
  exit 1
}

INSTALLER_VERSION="$(/usr/bin/sed -n "s/^COMPANION_VERSION='\([^']*\)'$/\1/p" "$INSTALLER")"
TEAM_ID="$(/usr/bin/sed -n "s/^TEAM_ID='\([^']*\)'$/\1/p" "$INSTALLER")"
[ "$INSTALLER_VERSION" = "$COMPANION_VERSION" ] && [[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || {
  echo "installer version or Team ID is invalid" >&2
  exit 1
}
EXPECTED_INSTALLER="$WORK/expected-install.sh"
/usr/bin/sed \
  -e "s/__RUNTIME_RAIDERS_COMPANION_VERSION__/$COMPANION_VERSION/g" \
  -e "s/__RUNTIME_RAIDERS_TEAM_ID__/$TEAM_ID/g" \
  "$ROOT/companion/packaging/install.sh" > "$EXPECTED_INSTALLER"
cmp -s "$INSTALLER" "$EXPECTED_INSTALLER" || {
  echo "install.sh is not the exact two-value template rendering" >&2
  exit 1
}
if /usr/bin/grep -F '__RUNTIME_RAIDERS_' "$INSTALLER" >/dev/null; then
  echo "install.sh contains an unrendered placeholder" >&2
  exit 1
fi

summary_value() {
  local key="$1"
  /usr/bin/awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, length(key) + 2) } END { if (count == 1) print value; else exit 1 }' "$SUMMARY"
}
for key in \
  git_sha companion_version bundle_identifier team_id codesign_verified hardened_runtime \
  secure_timestamp notarization stapled gatekeeper archive_shape install.sh_bytes \
  install.sh_sha256 runtime-raiders-agent.zip_bytes runtime-raiders-agent.zip_sha256 \
  version_bytes version_sha256; do
  summary_value "$key" >/dev/null || {
    echo "release-summary.txt is incomplete" >&2
    exit 1
  }
done
[ "$(/usr/bin/wc -l < "$SUMMARY" | /usr/bin/tr -d ' ')" -eq 17 ] || {
  echo "release-summary.txt contains unexpected fields" >&2
  exit 1
}
SUMMARY_GIT_SHA="$(summary_value git_sha)"
[[ "$SUMMARY_GIT_SHA" =~ ^[0-9a-f]{40}$ ]] &&
  [ "$(summary_value companion_version)" = "$COMPANION_VERSION" ] &&
  [ "$(summary_value bundle_identifier)" = com.redlattice.runtime-raiders-agent ] &&
  [ "$(summary_value team_id)" = "$TEAM_ID" ] &&
  [ "$(summary_value codesign_verified)" = true ] &&
  [ "$(summary_value hardened_runtime)" = true ] &&
  [ "$(summary_value secure_timestamp)" = true ] &&
  [ "$(summary_value notarization)" = Accepted ] &&
  [ "$(summary_value stapled)" = true ] &&
  [ "$(summary_value gatekeeper)" = accepted ] &&
  [ "$(summary_value archive_shape)" = one-app ] || {
  echo "release-summary.txt trust facts are invalid" >&2
  exit 1
}

check_summary_file() {
  local label="$1" file="$2" bytes sha
  bytes="$(/usr/bin/wc -c < "$file" | /usr/bin/tr -d ' ')"
  sha="$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk 'NR == 1 { print $1 }')"
  [ "$(summary_value "${label}_bytes")" = "$bytes" ] &&
    [ "$(summary_value "${label}_sha256")" = "$sha" ]
}
check_summary_file install.sh "$INSTALLER" &&
  check_summary_file runtime-raiders-agent.zip "$ARCHIVE" &&
  check_summary_file version "$VERSION_FILE" || {
  echo "release-summary.txt size or SHA-256 evidence does not match" >&2
  exit 1
}

EXTRACTED="$WORK/extracted"
/bin/mkdir "$EXTRACTED"
/usr/bin/ditto -x -k "$ARCHIVE" "$EXTRACTED"
AGENT_APP="$EXTRACTED/Runtime Raiders Agent.app"
AGENT_INFO="$AGENT_APP/Contents/Info.plist"
AGENT_EXECUTABLE="$AGENT_APP/Contents/MacOS/runtime-raiders-agent"
[ "$(/usr/bin/find "$EXTRACTED" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')" -eq 1 ] &&
  [ -d "$AGENT_APP" ] && [ ! -L "$AGENT_APP" ] &&
  [ -z "$(/usr/bin/find "$EXTRACTED" -type l -print -quit)" ] &&
  [ -f "$AGENT_INFO" ] && [ ! -L "$AGENT_INFO" ] &&
  [ -x "$AGENT_EXECUTABLE" ] && [ ! -L "$AGENT_EXECUTABLE" ] || {
  echo "archive does not contain exactly one safe Runtime Raiders Agent.app" >&2
  exit 1
}

BUNDLE_ID="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$AGENT_INFO")"
BUNDLE_EXECUTABLE="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$AGENT_INFO")"
BUNDLE_SHORT_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$AGENT_INFO")"
BUNDLE_VERSION="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$AGENT_INFO")"
[ "$BUNDLE_ID" = com.redlattice.runtime-raiders-agent ] &&
  [ "$BUNDLE_EXECUTABLE" = runtime-raiders-agent ] &&
  [ "$BUNDLE_SHORT_VERSION" = "$COMPANION_VERSION" ] &&
  [ "$BUNDLE_VERSION" = "$COMPANION_VERSION" ] || {
  echo "archive bundle identity or version is invalid" >&2
  exit 1
}

lipo "$AGENT_EXECUTABLE" -verify_arch arm64 x86_64
CODESIGN_FACTS="$(codesign -dv --verbose=4 "$AGENT_APP" 2>&1)"
printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -F "TeamIdentifier=$TEAM_ID" >/dev/null &&
  printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -E 'flags=.*runtime' >/dev/null &&
  printf '%s\n' "$CODESIGN_FACTS" | /usr/bin/grep -E '^Timestamp=.+' >/dev/null || {
  echo "archive signing facts are invalid" >&2
  exit 1
}
AGENT_REQUIREMENT='identifier "com.redlattice.runtime-raiders-agent" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "'"$TEAM_ID"'"'
codesign --verify --deep --strict --verbose=2 "$AGENT_APP"
codesign --verify --strict -R "$AGENT_REQUIREMENT" "$AGENT_APP"
spctl --assess --type execute --verbose=2 "$AGENT_APP"
xcrun stapler validate "$AGENT_APP"

SMOKE_HOME="$WORK/home"
SMOKE_BIN="$WORK/fake-bin"
SMOKE_APP="$WORK/smoke/Runtime Raiders Agent.app"
SMOKE_LOG="$WORK/smoke.log"
LOCAL_VERSION="$WORK/version-response"
/bin/mkdir -p "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders/outbox" "$SMOKE_BIN" "$(/usr/bin/dirname "$SMOKE_APP")"
/bin/chmod 700 "$SMOKE_HOME" "$SMOKE_HOME/Library" "$SMOKE_HOME/Library/Application Support" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state" \
  "$SMOKE_HOME/Library/Application Support/Runtime Raiders/outbox" "$SMOKE_BIN"
cat > "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state/enrollment.json" <<'EOF'
{"version":1,"device_id":"00000000-0000-4000-8000-000000000001","device_token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","dedupe_secret":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","server_url":"https://raiders.redlattice.com","cutover_at":1700000000000,"enabled_surfaces":["codex_desktop","codex_cli"]}
EOF
/bin/chmod 600 "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state/enrollment.json"
/usr/bin/ditto "$AGENT_APP" "$SMOKE_APP"
cat > "$SMOKE_APP/Contents/MacOS/runtime-raiders-agent" <<EOF
#!/bin/sh
set -eu
case "\${1:-status}" in
  status) printf '{"activationState":"disabled","companionVersion":"$COMPANION_VERSION"}\\n' ;;
  daemon) printf 'daemon\\n' >> "\$RR_VERIFY_SMOKE_LOG" ;;
  update)
    [ "\$(cat "\$RR_VERIFY_LOCAL_VERSION")" = '{"version":"$COMPANION_VERSION"}' ] || exit 1
    printf 'GET /version\\n' >> "\$RR_VERIFY_SMOKE_LOG"
    printf 'Runtime Raiders $COMPANION_VERSION is current.\\n'
    ;;
  on) exit 97 ;;
  *) exit 64 ;;
esac
EOF
/bin/chmod 755 "$SMOKE_APP/Contents/MacOS/runtime-raiders-agent"
printf '{"version":"%s"}\n' "$COMPANION_VERSION" > "$LOCAL_VERSION"
: > "$SMOKE_LOG"

cat > "$SMOKE_BIN/curl" <<'EOF'
#!/bin/sh
set -eu
output=''; url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output=$2; shift 2 ;;
    --write-out|-w|--proto|--proto-redir|--max-redirs|--connect-timeout|--max-time|--max-filesize|-X|-H|--data-binary) shift 2 ;;
    --fail|--silent|--show-error|-f|-s|-S) shift ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$url" = https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip ] || exit 97
printf 'GET %s\n' "$url" >> "$RR_VERIFY_SMOKE_LOG"
printf 'local archive fixture\n' > "$output"
printf 200
EOF
cat > "$SMOKE_BIN/ditto" <<'EOF'
#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = -x ] && [ "$2" = -k ] || exit 64
/bin/cp -R "$RR_VERIFY_SMOKE_APP" "$4/Runtime Raiders Agent.app"
EOF
cat > "$SMOKE_BIN/codesign" <<'EOF'
#!/bin/sh
set -eu
last=''; for last in "$@"; do :; done
case "$last" in *'/unpacked/Runtime Raiders Agent.app') : ;; *) exit 65 ;; esac
EOF
cat > "$SMOKE_BIN/spctl" <<'EOF'
#!/bin/sh
set -eu
last=''; for last in "$@"; do :; done
case "$last" in *'/unpacked/Runtime Raiders Agent.app') : ;; *) exit 65 ;; esac
EOF
cat > "$SMOKE_BIN/launchctl" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  bootout) printf 'launchctl bootout\n' >> "$RR_VERIFY_SMOKE_LOG" ;;
  bootstrap) printf 'launchctl bootstrap\n' >> "$RR_VERIFY_SMOKE_LOG" ;;
  *) exit 64 ;;
esac
EOF
/bin/chmod 700 "$SMOKE_BIN/curl" "$SMOKE_BIN/ditto" "$SMOKE_BIN/codesign" "$SMOKE_BIN/spctl" "$SMOKE_BIN/launchctl"

SMOKE_INSTALLER="$WORK/install-smoke.sh"
/usr/bin/sed \
  -e "s|/usr/bin/curl|$SMOKE_BIN/curl|g" \
  -e "s|/usr/bin/ditto|$SMOKE_BIN/ditto|g" \
  -e "s|/usr/bin/codesign|$SMOKE_BIN/codesign|g" \
  -e "s|/usr/sbin/spctl|$SMOKE_BIN/spctl|g" \
  -e "s|/bin/launchctl|$SMOKE_BIN/launchctl|g" \
  "$INSTALLER" > "$SMOKE_INSTALLER"
/bin/chmod 700 "$SMOKE_INSTALLER"

SMOKE_ENV=(
  HOME="$SMOKE_HOME"
  CFFIXED_USER_HOME="$SMOKE_HOME"
  RR_VERIFY_SMOKE_LOG="$SMOKE_LOG"
  RR_VERIFY_LOCAL_VERSION="$LOCAL_VERSION"
  RR_VERIFY_SMOKE_APP="$SMOKE_APP"
)

/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "${SMOKE_ENV[@]}" /bin/sh "$SMOKE_INSTALLER" >/dev/null
INSTALLED_COMMAND="$SMOKE_HOME/.local/bin/raiders"
[ -x "$INSTALLED_COMMAND" ] &&
  [ ! -e "$SMOKE_HOME/Library/Application Support/Runtime Raiders/state/collector-state.json" ] || {
  echo "fake-HOME fresh install did not remain off" >&2
  exit 1
}
STATUS_OUTPUT="$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$SMOKE_HOME" CFFIXED_USER_HOME="$SMOKE_HOME" \
  RR_VERIFY_SMOKE_LOG="$SMOKE_LOG" RR_VERIFY_LOCAL_VERSION="$LOCAL_VERSION" "$INSTALLED_COMMAND" status)"
printf '%s\n' "$STATUS_OUTPUT" | /usr/bin/grep -F '"activationState":"disabled"' >/dev/null || {
  echo "fake-HOME status smoke was not disabled" >&2
  exit 1
}
UPDATE_OUTPUT="$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$SMOKE_HOME" CFFIXED_USER_HOME="$SMOKE_HOME" \
  RR_VERIFY_SMOKE_LOG="$SMOKE_LOG" RR_VERIFY_LOCAL_VERSION="$LOCAL_VERSION" "$INSTALLED_COMMAND" update)"
[ "$UPDATE_OUTPUT" = "Runtime Raiders $COMPANION_VERSION is current." ] &&
  /usr/bin/grep -F -x 'GET /version' "$SMOKE_LOG" >/dev/null &&
  /usr/bin/grep -F -x 'GET https://raiders.redlattice.com/downloads/runtime-raiders-agent.zip' "$SMOKE_LOG" >/dev/null &&
  [ "$(/usr/bin/grep -c '^GET ' "$SMOKE_LOG")" -eq 2 ] || {
  echo "fake-HOME local update-check smoke failed" >&2
  exit 1
}

echo "Verified local Runtime Raiders beta $COMPANION_VERSION: one trusted app, fresh install off, local update check only."
